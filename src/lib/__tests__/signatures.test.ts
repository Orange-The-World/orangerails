/**
 * Tests for src/lib/signatures.ts.
 *
 * Coverage:
 *   - sign + verify round-trip through the base64 helpers.
 *   - Flipping one bit in the message → verify returns false.
 *   - Flipping one bit in the signature → verify returns false.
 *   - Unknown algorithm rejected.
 */

import { describe, it, expect } from "vitest";
import { generateSigKeyPair } from "../pqc";
import { signToBase64, verifyFromBase64 } from "../signatures";

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

describe("signatures: ML-DSA-65 via base64 helpers", () => {
  it("verifies an honest signature", async () => {
    const { publicKey, secretKey } = generateSigKeyPair();
    const { signature, algorithm } = await signToBase64(secretKey, "hello orange rails");
    expect(algorithm).toBe("ml-dsa-65");
    const ok = await verifyFromBase64(bytesToBase64(publicKey), "hello orange rails", signature);
    expect(ok).toBe(true);
  });

  it("rejects a tampered message", async () => {
    const { publicKey, secretKey } = generateSigKeyPair();
    const { signature } = await signToBase64(secretKey, "original");
    const ok = await verifyFromBase64(bytesToBase64(publicKey), "modified", signature);
    expect(ok).toBe(false);
  });

  it("rejects a tampered signature", async () => {
    const { publicKey, secretKey } = generateSigKeyPair();
    const { signature } = await signToBase64(secretKey, "audit event #42");
    const sigBytes = base64ToBytes(signature);
    sigBytes[7] ^= 0x01;
    const ok = await verifyFromBase64(
      bytesToBase64(publicKey),
      "audit event #42",
      bytesToBase64(sigBytes),
    );
    expect(ok).toBe(false);
  });

  it("rejects an unknown algorithm", async () => {
    const { secretKey } = generateSigKeyPair();
    await expect(signToBase64(secretKey, "x", "made-up")).rejects.toThrow(/unknown signature/);
  });
});
