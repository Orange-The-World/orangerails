/**
 * Account fingerprint and emitted-id generation.
 *
 * Two-layer account identity scheme (fleet standard):
 *
 * Layer 1 -- emitted id (the stable outward-facing identifier):
 *   128 bits of CSPRNG output (crypto.randomUUID). Minted once per
 *   connection at creation time. Derived from nothing. Zero information
 *   content. Cannot be reversed, confirmed, or correlated across accounts
 *   or organisations. Stable for the lifetime of the connection row:
 *   never update this column once set.
 *
 * Layer 2 -- fingerprint (internal only, NEVER emitted, logged, or returned):
 *   HMAC-SHA256(OR_ACCT_FINGERPRINT_KEY_V1,
 *     "orangerails/acct/v1" NUL subaccount_id NUL provider_type NUL canonical_account_key)
 *   Used only to answer "have we seen this account before?" (dedup).
 *   Keyed so no offline oracle or cross-system join is possible without
 *   the key.
 *
 * IMPORTANT: OR_ACCT_FINGERPRINT_KEY_V1 is a PERMANENT key for version v1.
 * Rotating it silently breaks dedup: the same account produces a new
 * fingerprint and a duplicate connection row is created instead of finding
 * the existing one. Any rotation MUST be preceded by a coordinated
 * re-fingerprinting migration that rewrites every existing fingerprint row
 * under the new key before the old key is retired. Never rotate without
 * that migration in place first.
 */

const ENV_KEY_NAME = "OR_ACCT_FINGERPRINT_KEY_V1";

/**
 * Domain separator for the account fingerprint scheme.
 * Exported so tests can assert directly that it differs from WALLET_DOMAIN_SEPARATOR.
 */
export const DOMAIN_SEPARATOR = "orangerails/acct/v1";

/**
 * Domain separator for the wallet fingerprint scheme.
 *
 * The wallet fingerprint shares ENV_KEY_NAME with the account fingerprint, so
 * the domain separator is the only guard keeping the two schemes apart. Under
 * one key, equal domains would let a message built for one column be mistaken
 * for the other, so these two strings must never be equal.
 *
 * Exported so tests can assert the invariant directly on the constants.
 */
export const WALLET_DOMAIN_SEPARATOR = "orangerails/wallet/v1";

export class AccountFingerprintKeyMissingError extends Error {
  constructor() {
    super(
      `[account-fingerprint] startup check failed: env var ${ENV_KEY_NAME} is empty or ` +
        `missing. Set it on the Supabase project before deploying this function.`,
    );
    this.name = "AccountFingerprintKeyMissingError";
  }
}

/**
 * Startup guard. Call once at module load time, before Deno.serve.
 * Throws AccountFingerprintKeyMissingError if OR_ACCT_FINGERPRINT_KEY_V1 is
 * empty or missing, so a misconfigured deploy fails loudly at boot instead of
 * silently falling back.
 */
export function guardAccountFingerprintKey(): void {
  const val = Deno.env.get(ENV_KEY_NAME) ?? "";
  if (!val) {
    throw new AccountFingerprintKeyMissingError();
  }
}

/**
 * Validate fingerprint fields: reject empty values and NUL bytes.
 *
 * A NUL inside a field makes the NUL-joined HMAC message ambiguous: two
 * different inputs can assemble to the same byte string and dedup onto each
 * other. An empty field is also rejected because it signals the caller did
 * not populate it correctly.
 *
 * Both computeAccountFingerprint and computeWalletFingerprint call this before
 * assembling the message, so the invariant is enforced at one site.
 */
function validateFingerprintFields(
  label: string,
  fields: Record<string, string>,
): void {
  for (const [name, value] of Object.entries(fields)) {
    if (!value) {
      throw new Error(`[account-fingerprint] ${label} field ${name} is empty`);
    }
    if (value.includes("\x00")) {
      throw new Error(
        `[account-fingerprint] ${label} field ${name} contains a NUL byte`,
      );
    }
  }
}

/**
 * Compute the HMAC-SHA256 fingerprint for a connection.
 *
 * fingerprint = HMAC-SHA256(
 *   OR_ACCT_FINGERPRINT_KEY_V1,
 *   "orangerails/acct/v1" \x00 subaccount_id \x00 provider_type \x00 canonical_account_key
 * )
 *
 * NUL bytes (\x00) separate the fields so that different field lengths cannot
 * produce the same concatenated message. All three fields are validated to
 * contain no NUL bytes before the message is assembled.
 *
 * Returns lowercase hex, 64 chars (32 bytes). INTERNAL ONLY. Must never appear
 * in any API response body, log line, or error message.
 *
 * OR_ACCT_FINGERPRINT_KEY_V1 is permanent for key version v1. See module
 * header for rotation policy.
 */
export async function computeAccountFingerprint(
  subaccountId: string,
  providerType: string,
  canonicalAccountKey: string,
): Promise<string> {
  const rawKey = Deno.env.get(ENV_KEY_NAME) ?? "";
  if (!rawKey) {
    // Should have been caught at startup; fail loudly here too so there is
    // no silent fallback path under any code ordering.
    throw new AccountFingerprintKeyMissingError();
  }

  validateFingerprintFields("account fingerprint", {
    subaccountId,
    providerType,
    canonicalAccountKey,
  });

  const enc = new TextEncoder();
  const message = [DOMAIN_SEPARATOR, subaccountId, providerType, canonicalAccountKey].join("\x00");

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(rawKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compute the per-wallet dedup fingerprint.
 *
 * wallet_fingerprint = HMAC-SHA256(
 *   OR_ACCT_FINGERPRINT_KEY_V1,
 *   "orangerails/wallet/v1" \x00 subaccount_id \x00 provider_type \x00
 *   canonical_account_key \x00 currency
 * )
 *
 * Reconnecting a provider account must reuse the existing source_wallet row
 * rather than create a duplicate. It cannot key on external_wallet_id, because
 * the adapter mints that as a fresh opaque UUID on every discovery, so the same
 * wallet looks brand new each time. This keys on the provider's real per-account
 * key instead, which is read server-side and never travels through the client.
 *
 * Five fields, one more than the account fingerprint: currency is included
 * because a provider can expose one wallet per currency under a single account
 * key. Without it, every currency under one account collapses to the same
 * fingerprint and they dedup onto each other.
 *
 * RETURNS RAW BYTES, not hex. source_wallets.wallet_fingerprint is BYTEA, while
 * connections.account_fingerprint is text, which is why computeAccountFingerprint
 * above hex-encodes and this does not. Writing the hex string into the BYTEA
 * column would store 64 ASCII bytes in place of the 32 real ones: consistent
 * enough to dedup, and wrong. Callers encode for the wire (PostgREST speaks
 * BYTEA as a leading \x plus hex).
 *
 * INTERNAL ONLY, exactly like the account fingerprint: never in a response body,
 * a log line, or an error message.
 *
 * Same key and same rotation policy as computeAccountFingerprint: see the module
 * header. Rotating the key without re-fingerprinting every existing row silently
 * turns every reconnect back into a duplicate.
 *
 * currency is normalized to uppercase inside this function, so callers need not
 * pre-normalize casing. The invariant is enforced here as a contract, not left
 * as a convention each call site must remember.
 */
export async function computeWalletFingerprint(
  subaccountId: string,
  providerType: string,
  canonicalAccountKey: string,
  currency: string,
): Promise<Uint8Array> {
  const rawKey = Deno.env.get(ENV_KEY_NAME) ?? "";
  if (!rawKey) {
    // Should have been caught at startup; fail loudly here too so there is no
    // silent fallback path under any code ordering.
    throw new AccountFingerprintKeyMissingError();
  }

  // canonical_account_key and currency arrive from a provider API response, so
  // the fields are validated rather than assumed well formed. A NUL inside a
  // field would make the split ambiguous, and an ambiguous message means two
  // different accounts can assemble identically and dedup onto each other.
  validateFingerprintFields("wallet fingerprint", {
    subaccountId,
    providerType,
    canonicalAccountKey,
    currency,
  });

  // Normalize currency casing here so parity is the function's own contract
  // rather than a convention every caller must repeat. Uppercasing is
  // idempotent and both existing call sites already uppercase, so this changes
  // no existing fingerprint and needs no key version bump.
  const normalizedCurrency = currency.toUpperCase();

  const enc = new TextEncoder();
  const message = [
    WALLET_DOMAIN_SEPARATOR,
    subaccountId,
    providerType,
    canonicalAccountKey,
    normalizedCurrency,
  ].join("\x00");

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(rawKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return new Uint8Array(sig);
}

/**
 * Mint a new account emitted id.
 *
 * 128 bits of CSPRNG output (UUIDv4). Minted once per connection at creation
 * time. Derived from nothing. Zero information content: cannot be reversed,
 * confirmed, or correlated across accounts or organisations even if the value
 * is observed. Stable for the lifetime of the connection row: never update
 * this column once set.
 */
export function generateAccountEmittedId(): string {
  return crypto.randomUUID();
}
