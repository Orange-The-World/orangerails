/**
 * OrangeRails post-quantum cryptography primitives.
 *
 * This module provides ONLY algorithmic primitives. All orchestration
 * (key wrapping per recipient, signature storage, vault lifecycle) lives
 * in neighbouring modules that import from here — see key-wrapping.ts,
 * signatures.ts, and pqc-lifecycle.ts.
 *
 * Algorithms:
 *   - Hybrid KEM: X25519 (RFC 7748) + ML-KEM-768 (FIPS 203) with
 *     HKDF-SHA-256 combiner. Shared-secret derivation follows the standard
 *     "belt-and-suspenders" pattern: a classical-only break AND a
 *     post-quantum-only break are BOTH required to recover the output.
 *   - Signatures: ML-DSA-65 (FIPS 204).
 *
 * Design rules:
 *   - No hand-rolled cryptography. All primitives come from @noble/curves
 *     and @noble/post-quantum, both pure-TypeScript and audited.
 *   - Inputs and outputs are Uint8Array at this layer; base64 encoding
 *     is the responsibility of orchestrators at storage boundaries.
 *   - Strict byte-length validation at every API boundary.
 *   - Constants are frozen; bumping a version means a new named constant
 *     plus coordinated migration.
 *
 * See docs/OrangeRails-PQC.md for the threat model and migration path.
 */

import { x25519 } from "@noble/curves/ed25519.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

// ------------------------------------------------------------------
// Sizes — derived from the standards, asserted at runtime.
// ------------------------------------------------------------------

export const HYBRID_KEM_V1 = Object.freeze({
  version: 1,
  /** RFC 7748 X25519 public-key length. */
  x25519PublicKeyBytes: 32,
  /** RFC 7748 X25519 secret-key length. */
  x25519SecretKeyBytes: 32,
  /** FIPS 203 ML-KEM-768 public-key length. */
  mlkemPublicKeyBytes: 1184,
  /** FIPS 203 ML-KEM-768 secret-key length. */
  mlkemSecretKeyBytes: 2400,
  /** FIPS 203 ML-KEM-768 ciphertext length. */
  mlkemCipherTextBytes: 1088,
  /** Length of the hybrid KEM shared secret (derived via HKDF-SHA-256). */
  sharedSecretBytes: 32,
  /** HKDF-SHA-256 info string — bump this when the combiner output changes. */
  hkdfInfo: "orangerails-hybrid-kem-v1",
} as const);

export const HYBRID_KEM_PUBLIC_KEY_BYTES =
  HYBRID_KEM_V1.x25519PublicKeyBytes + HYBRID_KEM_V1.mlkemPublicKeyBytes; // 1216
export const HYBRID_KEM_SECRET_KEY_BYTES =
  HYBRID_KEM_V1.x25519SecretKeyBytes + HYBRID_KEM_V1.mlkemSecretKeyBytes; // 2432
export const HYBRID_KEM_CIPHERTEXT_BYTES =
  HYBRID_KEM_V1.x25519PublicKeyBytes + HYBRID_KEM_V1.mlkemCipherTextBytes; // 1120

export const ML_DSA_65 = Object.freeze({
  /** FIPS 204 ML-DSA-65 public-key length. */
  publicKeyBytes: 1952,
  /** FIPS 204 ML-DSA-65 secret-key length. */
  secretKeyBytes: 4032,
  /** FIPS 204 ML-DSA-65 signature length. */
  signatureBytes: 3309,
} as const);

// ------------------------------------------------------------------
// Helpers — byte concatenation and slicing without hidden allocations.
// ------------------------------------------------------------------

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function assertLength(label: string, bytes: Uint8Array, expected: number): void {
  if (bytes.length !== expected) {
    throw new Error(`${label} must be ${expected} bytes, got ${bytes.length}`);
  }
}

// ------------------------------------------------------------------
// Hybrid KEM keypair — X25519 || ML-KEM-768.
// ------------------------------------------------------------------

export interface HybridKemKeyPair {
  /** concat(x25519_pub[32], mlkem768_pub[1184]) — HYBRID_KEM_PUBLIC_KEY_BYTES. */
  publicKey: Uint8Array;
  /** concat(x25519_sec[32], mlkem768_sec[2400]) — HYBRID_KEM_SECRET_KEY_BYTES. */
  secretKey: Uint8Array;
}

/**
 * Generate a fresh hybrid KEM keypair.
 *
 * X25519 randomness comes from @noble/curves, which uses the same WebCrypto
 * RNG the rest of this codebase relies on. ML-KEM-768 randomness comes from
 * @noble/post-quantum, which uses the same source.
 */
export function generateHybridKemKeyPair(): HybridKemKeyPair {
  const xSec = x25519.utils.randomSecretKey();
  const xPub = x25519.getPublicKey(xSec);
  const mlkem = ml_kem768.keygen();

  assertLength("X25519 public key", xPub, HYBRID_KEM_V1.x25519PublicKeyBytes);
  assertLength("X25519 secret key", xSec, HYBRID_KEM_V1.x25519SecretKeyBytes);
  assertLength("ML-KEM-768 public key", mlkem.publicKey, HYBRID_KEM_V1.mlkemPublicKeyBytes);
  assertLength("ML-KEM-768 secret key", mlkem.secretKey, HYBRID_KEM_V1.mlkemSecretKeyBytes);

  return {
    publicKey: concat(xPub, mlkem.publicKey),
    secretKey: concat(xSec, mlkem.secretKey),
  };
}

// ------------------------------------------------------------------
// Hybrid KEM combiner — HKDF-SHA-256 over (ss_classical || ss_pq).
// ------------------------------------------------------------------

function combineSharedSecrets(ssClassical: Uint8Array, ssPostQuantum: Uint8Array): Uint8Array {
  return hkdf(
    sha256,
    concat(ssClassical, ssPostQuantum),
    new Uint8Array(0),
    new TextEncoder().encode(HYBRID_KEM_V1.hkdfInfo),
    HYBRID_KEM_V1.sharedSecretBytes,
  );
}

export interface HybridKemCiphertext {
  /**
   * concat(x25519_ephemeral_pub[32], ml_kem768_ciphertext[1088])
   * — HYBRID_KEM_CIPHERTEXT_BYTES.
   */
  ciphertext: Uint8Array;
  /** 32-byte HKDF-derived shared secret, suitable as an AES-256-GCM key. */
  sharedSecret: Uint8Array;
}

/**
 * Encapsulate a shared secret to a recipient's hybrid public key.
 *
 * Output ciphertext bundles the X25519 ephemeral public key AND the ML-KEM
 * ciphertext, so the recipient can decapsulate both halves from a single
 * blob.
 *
 * The returned sharedSecret is the HKDF-SHA-256 combination of the two
 * component shared secrets — safe even if one of the two underlying
 * primitives is later broken.
 */
export function hybridEncapsulate(recipientPublicKey: Uint8Array): HybridKemCiphertext {
  assertLength("hybrid KEM public key", recipientPublicKey, HYBRID_KEM_PUBLIC_KEY_BYTES);

  const recipientX25519Pub = recipientPublicKey.subarray(0, HYBRID_KEM_V1.x25519PublicKeyBytes);
  const recipientMlkemPub = recipientPublicKey.subarray(HYBRID_KEM_V1.x25519PublicKeyBytes);

  const ephemeralSec = x25519.utils.randomSecretKey();
  const ephemeralPub = x25519.getPublicKey(ephemeralSec);
  const ssClassical = x25519.getSharedSecret(ephemeralSec, recipientX25519Pub);

  const { cipherText: mlkemCt, sharedSecret: ssPq } = ml_kem768.encapsulate(recipientMlkemPub);

  assertLength("X25519 ephemeral public key", ephemeralPub, HYBRID_KEM_V1.x25519PublicKeyBytes);
  assertLength("ML-KEM-768 ciphertext", mlkemCt, HYBRID_KEM_V1.mlkemCipherTextBytes);

  return {
    ciphertext: concat(ephemeralPub, mlkemCt),
    sharedSecret: combineSharedSecrets(ssClassical, ssPq),
  };
}

/**
 * Recover the shared secret from a hybrid KEM ciphertext using the
 * recipient's secret key.
 *
 * Throws on length mismatch. ML-KEM's implicit-rejection design means a
 * tampered ciphertext will NOT throw — it will produce a different shared
 * secret that will then fail downstream AES-GCM authentication. Callers
 * must rely on AEAD for integrity, not on this function throwing.
 */
export function hybridDecapsulate(secretKey: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  assertLength("hybrid KEM secret key", secretKey, HYBRID_KEM_SECRET_KEY_BYTES);
  assertLength("hybrid KEM ciphertext", ciphertext, HYBRID_KEM_CIPHERTEXT_BYTES);

  const x25519Sec = secretKey.subarray(0, HYBRID_KEM_V1.x25519SecretKeyBytes);
  const mlkemSec = secretKey.subarray(HYBRID_KEM_V1.x25519SecretKeyBytes);

  const ephemeralPub = ciphertext.subarray(0, HYBRID_KEM_V1.x25519PublicKeyBytes);
  const mlkemCt = ciphertext.subarray(HYBRID_KEM_V1.x25519PublicKeyBytes);

  const ssClassical = x25519.getSharedSecret(x25519Sec, ephemeralPub);
  const ssPq = ml_kem768.decapsulate(mlkemCt, mlkemSec);

  return combineSharedSecrets(ssClassical, ssPq);
}

// ------------------------------------------------------------------
// ML-DSA-65 signatures.
// ------------------------------------------------------------------

export interface SigKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** Generate a fresh ML-DSA-65 signing keypair. */
export function generateSigKeyPair(): SigKeyPair {
  const kp = ml_dsa65.keygen();
  assertLength("ML-DSA-65 public key", kp.publicKey, ML_DSA_65.publicKeyBytes);
  assertLength("ML-DSA-65 secret key", kp.secretKey, ML_DSA_65.secretKeyBytes);
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

/** Sign a message with an ML-DSA-65 secret key. */
export function sign(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
  assertLength("ML-DSA-65 secret key", secretKey, ML_DSA_65.secretKeyBytes);
  const sig = ml_dsa65.sign(message, secretKey);
  assertLength("ML-DSA-65 signature", sig, ML_DSA_65.signatureBytes);
  return sig;
}

/**
 * Verify a signature. Returns false (never throws) when inputs are
 * well-formed but the signature is invalid.
 */
export function verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== ML_DSA_65.publicKeyBytes) return false;
  if (signature.length !== ML_DSA_65.signatureBytes) return false;
  try {
    return ml_dsa65.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}
