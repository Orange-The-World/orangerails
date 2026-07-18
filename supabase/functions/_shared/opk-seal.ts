// Shared OPK (Owner Public Key) sealing helper for Supabase Edge Functions.
//
// This module is the ONE place any server-side code seals a plaintext under a
// user's Owner Public Key. It is seal-only by design: it exposes encryption to
// a public key and nothing else. There is deliberately no unseal path here,
// because unsealing needs the matching secret key, which lives only in the
// user's browser and never touches the server. Keeping unseal out of the
// server tree is what upholds the zero-knowledge (self-custody of your data)
// guarantee, so do not add a decrypt/open function to this file.
//
// Sealing uses libsodium's crypto_box_seal (an anonymous X25519 + XSalsa20
// Poly1305 sealed box). The sender is ephemeral and anonymous, so any function
// holding only the recipient's public key can seal, but only the holder of the
// secret key can open the result.

import sodium from 'https://esm.sh/libsodium-wrappers-sumo@0.7.13';

// Crypto suite identifier persisted alongside every sealed row and every
// registered OPK. Bump the version suffix if the suite ever changes so old
// rows stay unambiguously decodable. This constant is the single source of
// truth: callers must not hard-code the string.
export const OPK_SEAL_ALG = 'libsodium-crypto_box_seal-v1';

// Algorithms a caller is allowed to register or seal under today. A Set so
// registration endpoints can validate an incoming opk_alg in one lookup.
export const ALLOWED_OPK_ALGS: ReadonlySet<string> = new Set<string>([
  OPK_SEAL_ALG,
]);

// X25519 public key is 32 bytes. base64 (ORIGINAL variant) of 32 bytes is 44
// characters including one '=' pad. We bound the decoded byte length exactly
// and cap the encoded input length as a cheap pre-check.
const X25519_PUBLICKEY_BYTES = 32;
export const MAX_OPK_PUBLIC_LEN = 128;

let readyPromise: Promise<void> | null = null;

// Idempotent libsodium init. sodium.ready resolves once the wasm is loaded;
// we memoize the await so concurrent callers in one isolate share a single
// initialization rather than each awaiting from scratch.
async function ensureReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = sodium.ready;
  }
  await readyPromise;
}

/**
 * Decode and validate a base64 OPK public key into raw bytes.
 *
 * Throws if the input is not valid base64, or does not decode to a 32-byte
 * X25519 public key. Callers should treat a throw as a bad-request condition,
 * not a server fault: a malformed key is attacker- or client-controlled input.
 */
export async function decodeOpkPublicKey(opkPublicB64: string): Promise<Uint8Array> {
  await ensureReady();

  if (typeof opkPublicB64 !== 'string' || opkPublicB64.length === 0) {
    throw new Error('opk_public is empty');
  }
  if (opkPublicB64.length > MAX_OPK_PUBLIC_LEN) {
    throw new Error('opk_public is too long to be an X25519 public key');
  }

  let raw: Uint8Array;
  try {
    raw = sodium.from_base64(opkPublicB64, sodium.base64_variants.ORIGINAL);
  } catch {
    throw new Error('opk_public is not valid base64');
  }
  if (raw.length !== X25519_PUBLICKEY_BYTES) {
    throw new Error(
      `opk_public must decode to ${X25519_PUBLICKEY_BYTES} bytes, got ${raw.length}`,
    );
  }
  return raw;
}

/**
 * Seal a UTF-8 cleartext string under an already-decoded recipient public key
 * and return the sealed box as base64 (ORIGINAL variant).
 *
 * Use this overload when sealing many payloads to the same recipient: decode
 * the key once with decodeOpkPublicKey, then call this per row.
 */
export async function sealToOpk(
  cleartext: string,
  recipientPublicKey: Uint8Array,
): Promise<string> {
  await ensureReady();
  const sealed = sodium.crypto_box_seal(
    sodium.from_string(cleartext),
    recipientPublicKey,
  );
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

/**
 * Convenience one-shot: decode a base64 OPK public key and seal a single
 * cleartext under it. Prefer decodeOpkPublicKey + sealToOpk in a loop when
 * sealing multiple payloads to the same recipient.
 */
export async function sealCleartextForOpk(
  cleartext: string,
  opkPublicB64: string,
): Promise<string> {
  const recipientPublicKey = await decodeOpkPublicKey(opkPublicB64);
  return sealToOpk(cleartext, recipientPublicKey);
}
