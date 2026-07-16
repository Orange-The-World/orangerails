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
const DOMAIN_SEPARATOR = "orangerails/acct/v1";

/**
 * K_v, the wallet-fingerprint MAC key, lives in a KMS and never in an env var.
 * This names the KMS key resource; the secret itself is never readable by this
 * process. Unset means K_v has not been provisioned yet, which is the state
 * today: provisioning is a founder gate.
 */
const KMS_KEY_ID_ENV = "OR_WALLET_FINGERPRINT_KMS_KEY_ID";

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
    // Should have been caught at startup; fail loudly here too so there is
    // no silent fallback path under any code ordering.
    throw new AccountFingerprintKeyMissingError();
  }

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
 * Wallet fingerprint: the per-wallet dedup key, so a reconnect reuses the
 * existing source_wallet row instead of creating a duplicate.
 *
 *   wallet_fingerprint = KMS_GenerateMac(K_v,
 *     "orangerails/acct/v1" NUL subaccount_id NUL provider_type NUL
 *     canonical_account_key NUL currency)
 *
 * Two properties are required and neither is negotiable:
 *
 *   The MAC must be computed by a KMS under K_v. This process asks the KMS to
 *   compute a MAC and never reads the key itself, so the fingerprint must not
 *   be recomputable by anything holding only this function's environment, its
 *   logs, or a database dump. computeAccountFingerprint above is a different
 *   scheme for a different column: do not reuse it here.
 *
 *   Scope is subaccount_id. A fingerprint is meaningful only inside one
 *   subaccount, so the same provider account under two subaccounts must
 *   produce two unrelated values.
 *
 * INTERNAL ONLY, same as every other fingerprint here: never returned in a
 * response body, never logged, never put in an error message.
 */
export class KmsKeyNotProvisionedError extends Error {
  constructor() {
    super(
      `[account-fingerprint] wallet fingerprint requested but K_v is not provisioned: ` +
        `${KMS_KEY_ID_ENV} is empty or missing. Provisioning K_v is a founder gate.`,
    );
    this.name = "KmsKeyNotProvisionedError";
  }
}

export class KmsNotWiredError extends Error {
  constructor() {
    super(
      `[account-fingerprint] K_v is named by ${KMS_KEY_ID_ENV} but the KMS client is not ` +
        `wired yet, so no real MAC can be computed. Wire the KMS GenerateMac call before ` +
        `enabling wallet dedup.`,
    );
    this.name = "KmsNotWiredError";
  }
}

/**
 * True only when K_v has been provisioned and named to this function.
 *
 * Callers use this to decide whether a wallet fingerprint can be computed at
 * all. When it is false the correct behaviour is to leave wallet_fingerprint
 * NULL and skip dedup: the unique index on source_wallets.wallet_fingerprint is
 * partial (WHERE wallet_fingerprint IS NOT NULL) precisely so an un-fingerprinted
 * row is legal. It is never correct to substitute a different key, a weaker MAC,
 * or a plaintext account key to keep dedup running.
 */
export function isWalletFingerprintKeyProvisioned(): boolean {
  return (Deno.env.get(KMS_KEY_ID_ENV) ?? "") !== "";
}

/**
 * Assemble the exact byte string the KMS MACs over.
 *
 * NUL bytes separate the fields so two different field splits cannot produce
 * the same message: without a separator, ("ab","c") and ("a","bc") collide,
 * and a collision here means two different accounts dedup onto each other.
 * The domain separator leads so this MAC can never be confused with the
 * connection-level one over a shorter field list.
 *
 * canonical_account_key and currency arrive from a provider's API response, so
 * the fields are validated rather than assumed well-formed. A field carrying a
 * NUL byte would make the split ambiguous, so it is rejected: the caller must
 * fail rather than fingerprint an ambiguous message.
 */
export function walletFingerprintMessage(
  subaccountId: string,
  providerType: string,
  canonicalAccountKey: string,
  currency: string,
): Uint8Array {
  const fields = { subaccountId, providerType, canonicalAccountKey, currency };
  for (const [name, value] of Object.entries(fields)) {
    if (!value) {
      throw new Error(`[account-fingerprint] wallet fingerprint field ${name} is empty`);
    }
    if (value.includes("\x00")) {
      throw new Error(`[account-fingerprint] wallet fingerprint field ${name} contains a NUL byte`);
    }
  }
  return new TextEncoder().encode(
    [DOMAIN_SEPARATOR, subaccountId, providerType, canonicalAccountKey, currency].join("\x00"),
  );
}

/**
 * Ask the KMS to MAC a message under K_v.
 *
 * STUB. The real KMS GenerateMac call is a follow-up: K_v does not exist yet
 * and provisioning it plus its IAM policy is a founder gate. This deliberately
 * throws in both unprovisioned and provisioned states rather than returning
 * anything, so there is no code path anywhere that yields a fake, env-derived,
 * or otherwise not-real MAC. A fingerprint that is not a real KMS MAC is worse
 * than no fingerprint: it would be written to the database, deduped against,
 * and then be wrong forever once the real key landed.
 *
 * Guard every call with isWalletFingerprintKeyProvisioned().
 */
export function kmsGenerateMac(
  _message: Uint8Array,
): Promise<{ mac: Uint8Array; keyVersion: number }> {
  if (!isWalletFingerprintKeyProvisioned()) {
    return Promise.reject(new KmsKeyNotProvisionedError());
  }
  return Promise.reject(new KmsNotWiredError());
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
