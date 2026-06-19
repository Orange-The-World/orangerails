/**
 * Tests for src/lib/key-wrapping.ts.
 *
 * Coverage:
 *   - Wrap a 32-byte data key for 3 recipients; each recipient unwraps
 *     to the original bytes.
 *   - Cross-recipient unwrap MUST fail (AES-GCM auth-tag failure or
 *     underlying ML-KEM rejection).
 *   - Unknown algorithm string is rejected with a clear error.
 */

import { describe, it, expect } from "vitest";
import { generateHybridKemKeyPair } from "../pqc";
import {
  DEFAULT_WRAP_ALGORITHM,
  KEY_WRAP_STRATEGIES,
  base64ToBytes,
  wrapDataKeyForRecipients,
} from "../key-wrapping";

function randomDataKey(): Uint8Array {
  const out = new Uint8Array(32);
  crypto.getRandomValues(out);
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe("key-wrapping: hybrid-x25519-mlkem768", () => {
  it("each of three recipients unwraps to the same data key", async () => {
    const dataKey = randomDataKey();
    const recipients = [0, 1, 2].map((i) => {
      const kp = generateHybridKemKeyPair();
      return { userId: `user-${i}`, publicKey: kp.publicKey, secretKey: kp.secretKey };
    });

    const rows = await wrapDataKeyForRecipients(
      dataKey,
      recipients.map((r) => ({ userId: r.userId, publicKey: r.publicKey })),
    );
    expect(rows).toHaveLength(3);

    const strategy = KEY_WRAP_STRATEGIES[DEFAULT_WRAP_ALGORITHM];
    for (let i = 0; i < recipients.length; i++) {
      expect(rows[i].recipient_user_id).toBe(recipients[i].userId);
      expect(rows[i].algorithm).toBe(DEFAULT_WRAP_ALGORITHM);
      const wrappedBytes = base64ToBytes(rows[i].wrapped_ciphertext);
      const recovered = await strategy.unwrapForSelf(wrappedBytes, recipients[i].secretKey);
      expect(bytesEqual(recovered, dataKey)).toBe(true);
    }
  });

  it("recipient A cannot unwrap recipient B's row", async () => {
    const dataKey = randomDataKey();
    const alice = generateHybridKemKeyPair();
    const bob = generateHybridKemKeyPair();

    const rows = await wrapDataKeyForRecipients(dataKey, [
      { userId: "alice", publicKey: alice.publicKey },
      { userId: "bob", publicKey: bob.publicKey },
    ]);

    const strategy = KEY_WRAP_STRATEGIES[DEFAULT_WRAP_ALGORITHM];
    const bobRow = base64ToBytes(rows[1].wrapped_ciphertext);

    await expect(strategy.unwrapForSelf(bobRow, alice.secretKey)).rejects.toBeDefined();
  });

  it("rejects an unknown algorithm", async () => {
    const dataKey = randomDataKey();
    const kp = generateHybridKemKeyPair();
    await expect(
      wrapDataKeyForRecipients(dataKey, [{ userId: "x", publicKey: kp.publicKey }], "made-up"),
    ).rejects.toThrow(/unknown key-wrap algorithm/);
  });

  it("rejects a mis-sized data key", async () => {
    const kp = generateHybridKemKeyPair();
    await expect(
      wrapDataKeyForRecipients(new Uint8Array(16), [{ userId: "x", publicKey: kp.publicKey }]),
    ).rejects.toThrow(/data key must be 32 bytes/);
  });
});
