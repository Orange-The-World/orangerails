/**
 * Tests for src/lib/pqc.ts primitives.
 *
 * Coverage:
 *   - Hybrid KEM: round-trip shared-secret recovery (5 iterations with
 *     fresh keys) + byte-length assertions at the boundary.
 *   - ML-DSA-65: sign/verify round-trip; tampered-message and
 *     tampered-signature paths must return false without throwing.
 *   - NIST ACVP AFT keygen KATs for ML-KEM-768 (FIPS 203) and
 *     ML-DSA-65 (FIPS 204). See the NIST section header for source.
 *
 * ------------------------------------------------------------------
 * NIST ACVP source
 * ------------------------------------------------------------------
 * Vectors are extracted from NIST's official ACVP-Server repo:
 *   https://github.com/usnistgov/ACVP-Server/tree/master/gen-val/json-files
 *
 * AFT (Algorithm Functional Test) keygen tests provide the raw seed
 * material directly — `d`/`z` (32 B each, concatenated) for FIPS 203
 * ML-KEM and `seed` (32 B) for FIPS 204 ML-DSA. That is exactly what
 * @noble/post-quantum's `keygen(seed)` accepts, so no AES-CTR_DRBG
 * driver is needed.
 *
 * Two vectors per algorithm (tcIds 26 + 27 from the relevant test
 * group) are persisted as JSON fixtures under ./fixtures/ so the test
 * file stays readable. To refresh, pull from:
 *   gen-val/json-files/ML-KEM-keyGen-FIPS203/{prompt,expectedResults}.json
 *   gen-val/json-files/ML-DSA-keyGen-FIPS204/{prompt,expectedResults}.json
 * and re-extract the same tcIds.
 * ------------------------------------------------------------------
 */

import { describe, it, expect } from "vitest";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import {
  HYBRID_KEM_CIPHERTEXT_BYTES,
  HYBRID_KEM_PUBLIC_KEY_BYTES,
  HYBRID_KEM_SECRET_KEY_BYTES,
  ML_DSA_65,
  generateHybridKemKeyPair,
  generateSigKeyPair,
  hybridDecapsulate,
  hybridEncapsulate,
  sign,
  verify,
} from "../pqc";

// ------------------------------------------------------------------
// Small helpers.
// ------------------------------------------------------------------

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ------------------------------------------------------------------
// Hybrid KEM round-trip.
// ------------------------------------------------------------------

describe("pqc: hybrid KEM round-trip", () => {
  it("produces keypairs of the expected sizes", () => {
    const kp = generateHybridKemKeyPair();
    expect(kp.publicKey.length).toBe(HYBRID_KEM_PUBLIC_KEY_BYTES);
    expect(kp.secretKey.length).toBe(HYBRID_KEM_SECRET_KEY_BYTES);
  });

  it("shared secret decapsulates to the same bytes (5 iterations)", () => {
    for (let i = 0; i < 5; i++) {
      const { publicKey, secretKey } = generateHybridKemKeyPair();
      const { ciphertext, sharedSecret } = hybridEncapsulate(publicKey);
      expect(ciphertext.length).toBe(HYBRID_KEM_CIPHERTEXT_BYTES);
      expect(sharedSecret.length).toBe(32);

      const recovered = hybridDecapsulate(secretKey, ciphertext);
      expect(bytesEqual(recovered, sharedSecret)).toBe(true);
    }
  });

  it("rejects malformed public keys with a clear error", () => {
    expect(() => hybridEncapsulate(new Uint8Array(100))).toThrow(/must be 1216 bytes/);
  });

  it("rejects malformed secret keys with a clear error", () => {
    const { publicKey } = generateHybridKemKeyPair();
    const { ciphertext } = hybridEncapsulate(publicKey);
    expect(() => hybridDecapsulate(new Uint8Array(100), ciphertext)).toThrow(/must be 2432 bytes/);
  });
});

// ------------------------------------------------------------------
// ML-DSA-65 round-trip and tamper-detection.
// ------------------------------------------------------------------

describe("pqc: ML-DSA-65 sign / verify", () => {
  it("verifies a legitimate signature", () => {
    const { publicKey, secretKey } = generateSigKeyPair();
    expect(publicKey.length).toBe(ML_DSA_65.publicKeyBytes);
    expect(secretKey.length).toBe(ML_DSA_65.secretKeyBytes);

    const message = new TextEncoder().encode("orange rails, quantum safe");
    const signature = sign(secretKey, message);
    expect(signature.length).toBe(ML_DSA_65.signatureBytes);

    expect(verify(publicKey, message, signature)).toBe(true);
  });

  it("rejects a tampered message", () => {
    const { publicKey, secretKey } = generateSigKeyPair();
    const message = new TextEncoder().encode("intact message");
    const signature = sign(secretKey, message);
    const tampered = new Uint8Array(message);
    tampered[0] ^= 0x01;
    expect(verify(publicKey, tampered, signature)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const { publicKey, secretKey } = generateSigKeyPair();
    const message = new TextEncoder().encode("intact signature about to be flipped");
    const signature = sign(secretKey, message);
    const tampered = new Uint8Array(signature);
    tampered[10] ^= 0x01;
    expect(verify(publicKey, message, tampered)).toBe(false);
  });

  it("returns false (never throws) on malformed inputs", () => {
    const { publicKey, secretKey } = generateSigKeyPair();
    const message = new TextEncoder().encode("anything");
    const shortPub = new Uint8Array(100);
    const shortSig = new Uint8Array(50);
    expect(verify(shortPub, message, sign(secretKey, message))).toBe(false);
    expect(verify(publicKey, message, shortSig)).toBe(false);
  });
});

// ------------------------------------------------------------------
// NIST ACVP AFT keygen KATs — FIPS 203 / 204.
// Fixtures are extracted from the NIST ACVP-Server JSON files; see
// the file header for source URLs and extraction procedure.
// ------------------------------------------------------------------

import kemKat from "./fixtures/nist-acvp-ml-kem-768.json";
import dsaKat from "./fixtures/nist-acvp-ml-dsa-65.json";

function hexToBytes(h: string): Uint8Array {
  if (h.length % 2 !== 0) throw new Error(`odd hex length: ${h.length}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

describe(`pqc: NIST ACVP ${kemKat.parameterSet} AFT keygen`, () => {
  for (const t of kemKat.tests) {
    it(`tcId ${t.tcId} — pk and sk match NIST expected`, () => {
      const seed = concatBytes(hexToBytes(t.d), hexToBytes(t.z));
      expect(seed.length).toBe(64);
      const { publicKey, secretKey } = ml_kem768.keygen(seed);
      expect(hex(publicKey)).toBe(t.ek.toLowerCase());
      expect(hex(secretKey)).toBe(t.dk.toLowerCase());
    });
  }
});

describe(`pqc: NIST ACVP ${dsaKat.parameterSet} AFT keygen`, () => {
  for (const t of dsaKat.tests) {
    it(`tcId ${t.tcId} — pk and sk match NIST expected`, () => {
      const seed = hexToBytes(t.seed);
      expect(seed.length).toBe(32);
      const { publicKey, secretKey } = ml_dsa65.keygen(seed);
      expect(hex(publicKey)).toBe(t.pk.toLowerCase());
      expect(hex(secretKey)).toBe(t.sk.toLowerCase());
    });
  }
});
