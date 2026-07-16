/**
 * Account and wallet fingerprint and emitted-id generation.
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
 * Layer 2 -- account fingerprint (internal only, NEVER emitted, logged, or returned):
 *   HMAC-SHA256(OR_ACCT_FINGERPRINT_KEY_V1,
 *     "orangerails/acct/v1" NUL subaccount_id NUL provider_type NUL canonical_account_key)
 *   Used only to answer "have we seen this account before?" (dedup).
 *   Keyed so no offline oracle or cross-system join is possible without
 *   the key.
 *
 * Layer 3 -- wallet fingerprint (internal only, NEVER emitted, logged, or returned):
 *   HMAC-SHA256(OR_ACCT_FINGERPRINT_KEY_V1,
 *     "orangerails/wallet/v1" NUL subaccount_id NUL provider_type NUL account_key NUL currency)
 *   Used only to answer "have we seen this wallet before?" (reconnect dedup).
 *   Computed server-side in or-link-complete so a compromised widget cannot
 *   forge or cross-account-match fingerprints.
 *
 * IMPORTANT: OR_ACCT_FINGERPRINT_KEY_V1 is a PERMANENT key for version v1.
 * Rotating it silently breaks dedup: the same account or wallet produces a new
 * fingerprint and a duplicate row is created instead of finding the existing one.
 * Any rotation MUST be preceded by a coordinated re-fingerprinting migration that
 * rewrites every existing fingerprint row under the new key before the old key is
 * retired. Never rotate without that migration in place first.
 */

const ENV_KEY_NAME = "OR_ACCT_FINGERPRINT_KEY_V1";
const ACCT_DOMAIN_SEPARATOR = "orangerails/acct/v1";
const WALLET_DOMAIN_SEPARATOR = "orangerails/wallet/v1";

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
 * Compute the HMAC-SHA256 fingerprint for a connection.
 *
 * fingerprint = HMAC-SHA256(
 *   OR_ACCT_FINGERPRINT_KEY_V1,
 *   "orangerails/acct/v1" \x00 subaccount_id \x00 provider_type \x00 canonical_account_key
 * )
 *
 * NUL bytes (\x00) separate the fields so that different field lengths cannot
 * produce the same concatenated message. None of the three fields (UUID,
 * provider slug, wallet/account id) ever contain NUL bytes.
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
    throw new AccountFingerprintKeyMissingError();
  }

  const enc = new TextEncoder();
  const message = [ACCT_DOMAIN_SEPARATOR, subaccountId, providerType, canonicalAccountKey].join(
    "\x00",
  );

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
 * Compute the HMAC-SHA256 fingerprint for a single wallet.
 *
 * fingerprint = HMAC-SHA256(
 *   OR_ACCT_FINGERPRINT_KEY_V1,
 *   "orangerails/wallet/v1" \x00 subaccount_id \x00 provider_type \x00
 *   account_key \x00 currency
 * )
 *
 * NUL bytes separate the fields so that different field lengths cannot
 * produce the same concatenated message. Computed server-side in
 * or-link-complete so a compromised widget cannot forge or cross-account-match
 * fingerprints. Stable for the lifetime of the
 * (subaccount, provider, account, currency) tuple.
 *
 * Returns lowercase hex, 64 chars (32 bytes). INTERNAL ONLY. Must never
 * appear in any API response body, log line, or error message.
 *
 * Shares OR_ACCT_FINGERPRINT_KEY_V1 and the same rotation policy as
 * computeAccountFingerprint. See module header.
 */
export async function computeWalletFingerprint(
  subaccountId: string,
  providerType: string,
  accountKey: string,
  currency: string,
): Promise<string> {
  const rawKey = Deno.env.get(ENV_KEY_NAME) ?? "";
  if (!rawKey) {
    throw new AccountFingerprintKeyMissingError();
  }

  const enc = new TextEncoder();
  const message = [
    WALLET_DOMAIN_SEPARATOR,
    subaccountId,
    providerType,
    accountKey,
    currency,
  ].join("\x00");

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
