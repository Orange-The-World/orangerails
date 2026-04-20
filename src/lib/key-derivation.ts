/**
 * HKDF-based subkey derivation for OrangeRails.
 *
 * The MEK (Master Encryption Key, derived from the user's vault password
 * via Argon2id in vault.ts) is used as HKDF input material. From it we
 * derive purpose-specific subkeys using distinct context strings.
 *
 * This is the standard "key-separation" pattern used in Signal, Noise,
 * TLS 1.3, and every modern cryptographic protocol. If one subkey is
 * ever compromised in isolation, the others remain safe.
 *
 * Context strings are VERSIONED. Bumping the version here requires a
 * coordinated migration: the old key won't decrypt data encrypted with
 * the new key, so a caller that sees a `payload_key_version` older than
 * the current must derive the appropriate legacy subkey.
 *
 * See docs/OrangeRails-Architecture.md §5.2 (Key Hierarchy).
 */

import { importAesKey, importAesKeyNonExtractable } from './vault';

// ------------------------------------------------------------------
// HKDF context strings — one per purpose, never reused.
// ------------------------------------------------------------------

export const HKDF_CONTEXTS = Object.freeze({
  /** Encrypts provider credentials (Blink API key, Kraken secret, etc.) stored at OR. */
  ORANGERAILS_CREDENTIALS_V1: 'orangerails-creds-v1',
  /** Encrypts normalized transaction payloads stored at OR. */
  ORANGERAILS_TRANSACTIONS_V1: 'orangerails-txns-v1',
  /** Encrypts the vault verifier ciphertext for password-correctness checks. */
  ORANGERAILS_VERIFIER_V1: 'orangerails-verifier-v1',
  /** Encrypts the user's PQC secret keys (hybrid KEM + ML-DSA) at rest. */
  ORANGERAILS_PQC_SECRET_WRAP_V1: 'orangerails-pqc-secret-wrap-v1',
} as const);

export type HkdfContext = (typeof HKDF_CONTEXTS)[keyof typeof HKDF_CONTEXTS];

// ------------------------------------------------------------------
// Subkey derivation — HKDF-SHA-256.
// ------------------------------------------------------------------

/**
 * Derive a 256-bit subkey from the MEK using HKDF with a distinct context.
 *
 * The returned CryptoKey is imported as AES-256-GCM, usable for encrypt/decrypt.
 * The raw bytes are never extracted back out into JavaScript.
 *
 * @param mek       MEK as produced by deriveMEK() in vault.ts.
 * @param context   One of HKDF_CONTEXTS.
 * @param saltB64   The user's vault salt (same salt used for Argon2id). Base64.
 */
export async function deriveSubkey(
  mek: CryptoKey,
  context: HkdfContext,
  saltB64: string,
): Promise<CryptoKey> {
  const saltBytes = base64ToBytes(saltB64);
  const infoBytes = new TextEncoder().encode(context);

  // HKDF-derive 32 bytes of raw key material.
  const rawBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: saltBytes as BufferSource,
      info: infoBytes as BufferSource,
    },
    mek,
    256,
  );

  return importAesKey(rawBits);
}

/**
 * Convenience: derive the credentials subkey (for `connections.encrypted_credentials`).
 */
export async function deriveCredentialsKey(mek: CryptoKey, saltB64: string): Promise<CryptoKey> {
  return deriveSubkey(mek, HKDF_CONTEXTS.ORANGERAILS_CREDENTIALS_V1, saltB64);
}

/**
 * Convenience: derive the transactions subkey (for `encrypted_transactions.encrypted_payload`).
 */
export async function deriveTransactionsKey(mek: CryptoKey, saltB64: string): Promise<CryptoKey> {
  return deriveSubkey(mek, HKDF_CONTEXTS.ORANGERAILS_TRANSACTIONS_V1, saltB64);
}

/**
 * Convenience: derive the subkey used to wrap PQC secret keys at rest.
 *
 * Extractable so the same AES-256-GCM CryptoKey can be handed to
 * encryptString/decryptString in src/lib/vault.ts. The wrapped
 * output lives in user_vault_meta.kem_secret_wrapped and
 * user_vault_meta.sig_secret_wrapped.
 */
export async function derivePqcSecretWrapKey(mek: CryptoKey, saltB64: string): Promise<CryptoKey> {
  return deriveSubkey(mek, HKDF_CONTEXTS.ORANGERAILS_PQC_SECRET_WRAP_V1, saltB64);
}

/**
 * Convenience: derive the verifier subkey (for `user_vault_meta.vault_verifier_ciphertext`).
 *
 * The verifier subkey is ALWAYS non-extractable — it is used only for local
 * decryption of the verifier ciphertext, never transmitted anywhere.
 */
export async function deriveVerifierKey(mek: CryptoKey, saltB64: string): Promise<CryptoKey> {
  const saltBytes = base64ToBytes(saltB64);
  const infoBytes = new TextEncoder().encode(HKDF_CONTEXTS.ORANGERAILS_VERIFIER_V1);

  const rawBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: saltBytes as BufferSource,
      info: infoBytes as BufferSource,
    },
    mek,
    256,
  );

  return importAesKeyNonExtractable(rawBits);
}

// ------------------------------------------------------------------
// Local base64 helper — kept inline to avoid a cross-module dependency
// that would hurt tree-shaking of this cryptography module.
// ------------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
