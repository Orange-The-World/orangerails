/**
 * OrangeRails vault — core cryptographic primitives.
 *
 * Implements the session-based zero-knowledge design described in
 * docs/OrangeRails-Architecture.md §5.
 *
 * Responsibilities of this module:
 *   1. Derive the Master Encryption Key (MEK) from a vault password using
 *      Argon2id (memory-hard KDF, OWASP 2023 parameters).
 *   2. Provide AES-256-GCM encrypt/decrypt over base64-encoded ciphertext.
 *   3. Generate vault verifier strings so a client can prove to itself that
 *      a password is correct (without ever transmitting it).
 *
 * Design rules this module upholds:
 *   - The vault password NEVER leaves the caller.
 *   - The MEK is never exported to persistent storage. It lives only as a
 *     WebCrypto `CryptoKey` inside the browser tab's memory.
 *   - CryptoKey objects are created non-extractable whenever possible.
 *   - All randomness comes from `crypto.getRandomValues()` (Web Crypto).
 *   - No key material is ever logged.
 *
 * ⚠️ Do not import this module in server-side (edge function) code. The
 *    architecture forbids the server holding vault material at rest;
 *    enforcing that at the import boundary prevents accidental leakage.
 */

import { argon2id } from "hash-wasm";

// ------------------------------------------------------------------
// Configuration — bumped via vault_key_version, never mutated in place.
// ------------------------------------------------------------------

export const ARGON2ID_V1 = Object.freeze({
  version: 1,
  memorySize: 65536, // KiB — OWASP 2023 recommended
  iterations: 3,
  parallelism: 4,
  hashLength: 32, // 256-bit output → AES-256 key
} as const);

/** Minimum vault password length. Enforced on setup. */
export const MIN_PASSWORD_LENGTH = 12;

/** Public string a successful decryption will produce, proving the key is correct. */
export const VAULT_VERIFIER_PLAINTEXT = "orangerails-vault-verifier-v1";

// ------------------------------------------------------------------
// Encoding helpers — base64 is our on-the-wire format.
// ------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function stringToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

// ------------------------------------------------------------------
// Salt generation.
// ------------------------------------------------------------------

/** Generate a fresh 128-bit random salt, returned as base64. */
export function generateVaultSalt(): string {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return bytesToBase64(salt);
}

// ------------------------------------------------------------------
// Key derivation — Argon2id.
// ------------------------------------------------------------------

/**
 * Derive the Master Encryption Key (MEK) from a vault password.
 *
 * @param password      The user's vault password. String form, not ever persisted.
 * @param saltBase64    The per-user salt (from user_vault_meta.vault_salt).
 * @param version       The key version to use. Defaults to latest.
 *
 * Returns a non-extractable CryptoKey suitable for use as an HKDF input
 * (not directly as an AES key — HKDF-derived subkeys are the AES keys).
 */
export async function deriveMEK(
  password: string,
  saltBase64: string,
  version: number = ARGON2ID_V1.version,
): Promise<CryptoKey> {
  if (version !== ARGON2ID_V1.version) {
    throw new Error(`Unknown vault key version: ${version}`);
  }

  const passwordBytes = stringToBytes(password);
  const saltBytes = base64ToBytes(saltBase64);

  const hashBytes = await argon2id({
    password: passwordBytes,
    salt: saltBytes,
    parallelism: ARGON2ID_V1.parallelism,
    iterations: ARGON2ID_V1.iterations,
    memorySize: ARGON2ID_V1.memorySize,
    hashLength: ARGON2ID_V1.hashLength,
    outputType: "binary",
  });

  // Import as HKDF material. Non-extractable — the key can be used to derive
  // further keys but cannot be read out of the CryptoKey object.
  return crypto.subtle.importKey(
    "raw",
    hashBytes as BufferSource,
    { name: "HKDF" },
    /* extractable */ false,
    ["deriveKey", "deriveBits"],
  );
}

// ------------------------------------------------------------------
// AES-256-GCM — primitive encrypt/decrypt.
// ------------------------------------------------------------------

/**
 * Import a 32-byte raw key for AES-256-GCM use.
 *
 * extractable=true is required for subkeys that need to be handed to the
 * sync edge function in-transit. The server uses them in-memory for a
 * single sync request and discards them; never persists. For pure-client
 * encryption/decryption this extra capability is unused and harmless.
 *
 * If a caller wants a hardened non-extractable key (e.g., a verifier key
 * that is only ever used locally), call `importAesKeyNonExtractable` below.
 */
export async function importAesKey(rawBytes: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", rawBytes, { name: "AES-GCM" }, /* extractable */ true, [
    "encrypt",
    "decrypt",
  ]);
}

/** Import a CryptoKey that can NEVER be extracted back into raw bytes. */
export async function importAesKeyNonExtractable(rawBytes: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", rawBytes, { name: "AES-GCM" }, /* extractable */ false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Encrypt a UTF-8 string with AES-256-GCM.
 *
 * Output format: base64( IV[12] || ciphertext || auth_tag[16] )
 * This single-string format means we only ever persist one column value,
 * not an (iv, ciphertext, tag) tuple.
 */
export async function encryptString(plaintext: string, key: CryptoKey): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);

  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    stringToBytes(plaintext) as BufferSource,
  );

  const ciphertext = new Uint8Array(ciphertextBuffer);
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);

  return bytesToBase64(combined);
}

/**
 * Decrypt a string produced by encryptString.
 *
 * Throws if the key is wrong or the ciphertext has been tampered with —
 * AES-GCM authentication means the tag MUST validate.
 */
export async function decryptString(ciphertextB64: string, key: CryptoKey): Promise<string> {
  const combined = base64ToBytes(ciphertextB64);
  if (combined.length < 12 + 16) {
    throw new Error("Ciphertext too short to be valid AES-GCM output");
  }
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const plaintextBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);

  return bytesToString(new Uint8Array(plaintextBuffer));
}

// ------------------------------------------------------------------
// Vault verifier — proves correctness of a derived key.
// ------------------------------------------------------------------

/**
 * Create a verifier ciphertext: AES-256-GCM(VAULT_VERIFIER_PLAINTEXT).
 *
 * This is stored on the server in `user_vault_meta.vault_verifier_ciphertext`.
 * Without the correct MEK, decryption fails. With it, the known plaintext
 * appears. The verifier proves correctness without ever transmitting the
 * password or the derived key.
 */
export async function createVaultVerifier(verifierKey: CryptoKey): Promise<string> {
  return encryptString(VAULT_VERIFIER_PLAINTEXT, verifierKey);
}

/**
 * Verify a password against a stored verifier.
 *
 * Usage: on login, derive MEK from the entered password, derive the verifier
 * subkey from it, pass that subkey here along with the stored ciphertext.
 * Returns true iff the decrypted plaintext matches VAULT_VERIFIER_PLAINTEXT.
 */
export async function verifyVaultPassword(
  verifierKey: CryptoKey,
  storedVerifierCiphertext: string,
): Promise<boolean> {
  try {
    const decrypted = await decryptString(storedVerifierCiphertext, verifierKey);
    return decrypted === VAULT_VERIFIER_PLAINTEXT;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------
// Password strength gate — enforced on vault setup.
// ------------------------------------------------------------------

/**
 * Basic password strength check.
 *
 * The LastPass 2022 breach taught the whole industry that ZKA is only as
 * strong as user-chosen passwords. This check rejects the lowest-hanging
 * fruit (too short, purely alphabetic, purely numeric, obviously weak).
 *
 * We deliberately do NOT attempt to reject all weak passwords — zxcvbn
 * integration happens in the UI layer. This is the library-level bottom
 * floor.
 */
export function isPasswordAcceptable(
  password: string,
): { ok: true } | { ok: false; reason: string } {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  const lower = password.toLowerCase();
  const blocklist = ["password", "123456", "qwerty", "letmein", "orangerails", "bitcoin"];
  if (blocklist.some((bad) => lower.includes(bad))) {
    return { ok: false, reason: "Password contains a common weak pattern." };
  }
  if (/^[a-z]+$/i.test(password)) {
    return { ok: false, reason: "Password must contain more than just letters." };
  }
  if (/^[0-9]+$/.test(password)) {
    return { ok: false, reason: "Password cannot be digits only." };
  }
  return { ok: true };
}

// ------------------------------------------------------------------
// Raw MEK bytes — for the co-admin grant flow only.
// ------------------------------------------------------------------

/**
 * Re-run Argon2id and return the raw 32-byte hash.
 *
 * This is the ONLY sanctioned way to get extractable key material from the
 * vault password. It is used exclusively in the co-admin grant flow, where
 * the owner must re-confirm their vault password so the browser can
 * concatenate credentials+transactions subkeys into a 64-byte blob and wrap
 * it for the recipient's PQC public key.
 *
 * The returned bytes are transient: callers must derive subkeys from them
 * immediately and then let the array be garbage-collected. Never persist or
 * log the returned value.
 *
 * @param password   The user's vault password (re-confirmed in the dialog).
 * @param saltBase64 The per-user salt (from user_vault_meta.vault_salt).
 */
export async function deriveMekRaw(password: string, saltBase64: string): Promise<Uint8Array> {
  const passwordBytes = stringToBytes(password);
  const saltBytes = base64ToBytes(saltBase64);

  const hashBytes = await argon2id({
    password: passwordBytes,
    salt: saltBytes,
    parallelism: ARGON2ID_V1.parallelism,
    iterations: ARGON2ID_V1.iterations,
    memorySize: ARGON2ID_V1.memorySize,
    hashLength: ARGON2ID_V1.hashLength,
    outputType: "binary",
  });

  return hashBytes as Uint8Array;
}

// ------------------------------------------------------------------
// Re-export encoding helpers — some callers need them for interop.
// ------------------------------------------------------------------

export const encoding = {
  bytesToBase64,
  base64ToBytes,
  stringToBytes,
  bytesToString,
};
