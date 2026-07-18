/**
 * Sealed-envelope round-trip, key-guard, and blind-index tests.
 *
 * Runs under Vitest's node environment. Node 20 has Web Crypto as a
 * global (`globalThis.crypto`), so the same code paths run in tests as
 * in the browser.
 */

import { describe, expect, it } from "vitest";

import {
  computeTxidBlindIndex,
  sealEnvelope,
  StealthKeyInvalidError,
  StealthKeyMissingError,
  StealthTxidInvalidError,
  unsealEnvelope,
  type SealedEnvelope,
} from "./seal";

function keyOfBytes(n: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(n));
  let s = "";
  for (let i = 0; i < raw.length; i++) s += String.fromCharCode(raw[i]);
  return btoa(s);
}

function randomKeyB64(): string {
  return keyOfBytes(32);
}

/** A canonical txid: lowercase hex, display byte order, 64 chars. */
const TXID_A =
  "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b";
const TXID_B =
  "b1fea52486ce0c62bb442b530a3f0132b826c74e473d1f2c220bfa78111c5082";

describe("sealEnvelope / unsealEnvelope", () => {
  it("round-trips a JSON-serializable payload", async () => {
    const key = randomKeyB64();
    const payload = {
      kind: "xpub_stealth",
      xpub: "zpub6jftahH18ngZxLmXaKw3GSZzZsszmt9WqedkyZdezFtWRFBZqsQH5hyUmb4pCEeZGmVfQuP5bedXTB8is6fTv19U1GQRyQUKQGUTzyHACMF",
      label: "Sparrow main",
      wallet_birthday: "2021-01-15",
      gap_limit: 20,
      script_type: "p2wpkh",
    };

    const env = await sealEnvelope(payload, key);
    expect(env.version).toBe(1);
    expect(env.algorithm).toBe("AES-256-GCM");
    expect(env.iv_b64.length).toBeGreaterThan(0);
    expect(env.ciphertext_b64.length).toBeGreaterThan(0);

    const decoded = await unsealEnvelope<typeof payload>(env, key);
    expect(decoded).toEqual(payload);
  });

  it("uses a fresh IV per envelope so two seals of the same payload differ", async () => {
    const key = randomKeyB64();
    const payload = { hello: "world" };
    const a = await sealEnvelope(payload, key);
    const b = await sealEnvelope(payload, key);
    expect(a.iv_b64).not.toBe(b.iv_b64);
    expect(a.ciphertext_b64).not.toBe(b.ciphertext_b64);
  });

  it("fails to unseal under the wrong key", async () => {
    const goodKey = randomKeyB64();
    const wrongKey = randomKeyB64();
    const env = await sealEnvelope({ x: 1 }, goodKey);
    await expect(unsealEnvelope(env, wrongKey)).rejects.toBeDefined();
  });

  it("fails on tampered ciphertext", async () => {
    const key = randomKeyB64();
    const env = await sealEnvelope({ x: 1 }, key);
    // Flip a byte in the ciphertext.
    const ct = atob(env.ciphertext_b64);
    const bytes = new Uint8Array(ct.length);
    for (let i = 0; i < ct.length; i++) bytes[i] = ct.charCodeAt(i);
    bytes[0] ^= 0x01;
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    const tampered = { ...env, ciphertext_b64: btoa(s) };
    await expect(unsealEnvelope(tampered, key)).rejects.toBeDefined();
  });
});

/**
 * A key that is absent must be a loud, typed refusal, never a lucky
 * exception. These tests pin that: they must keep passing even if the
 * base64 decode path is ever swapped for one that tolerates junk input.
 */
describe("key guard", () => {
  // The runtime values a keyless caller can actually arrive with. The casts
  // are the point: TypeScript's `string` is not a runtime fact when the value
  // originates in a postMessage payload.
  const missingKeys: Array<[string, string]> = [
    ["undefined", undefined as unknown as string],
    ["empty string", ""],
  ];
  const invalidKeys: Array<[string, string]> = [
    ["31-byte key", keyOfBytes(31)],
    ["33-byte key", keyOfBytes(33)],
  ];

  async function envelopeForTest(): Promise<SealedEnvelope> {
    return sealEnvelope({ x: 1 }, randomKeyB64());
  }

  describe("sealEnvelope", () => {
    for (const [label, key] of missingKeys) {
      it(`throws StealthKeyMissingError for a ${label}`, async () => {
        await expect(sealEnvelope({ x: 1 }, key)).rejects.toBeInstanceOf(
          StealthKeyMissingError,
        );
      });
    }
    for (const [label, key] of invalidKeys) {
      it(`throws StealthKeyInvalidError for a ${label}`, async () => {
        await expect(sealEnvelope({ x: 1 }, key)).rejects.toBeInstanceOf(
          StealthKeyInvalidError,
        );
      });
    }
    it("produces no envelope at all when the key is missing", async () => {
      let result: SealedEnvelope | undefined;
      try {
        result = await sealEnvelope({ x: 1 }, undefined as unknown as string);
      } catch {
        // expected
      }
      expect(result).toBeUndefined();
    });
  });

  describe("unsealEnvelope", () => {
    for (const [label, key] of missingKeys) {
      it(`throws StealthKeyMissingError for a ${label}`, async () => {
        const env = await envelopeForTest();
        await expect(unsealEnvelope(env, key)).rejects.toBeInstanceOf(
          StealthKeyMissingError,
        );
      });
    }
    for (const [label, key] of invalidKeys) {
      it(`throws StealthKeyInvalidError for a ${label}`, async () => {
        const env = await envelopeForTest();
        await expect(unsealEnvelope(env, key)).rejects.toBeInstanceOf(
          StealthKeyInvalidError,
        );
      });
    }
  });

  describe("computeTxidBlindIndex", () => {
    for (const [label, key] of missingKeys) {
      it(`throws StealthKeyMissingError for a ${label}`, async () => {
        await expect(
          computeTxidBlindIndex(TXID_A, key),
        ).rejects.toBeInstanceOf(StealthKeyMissingError);
      });
    }
    for (const [label, key] of invalidKeys) {
      it(`throws StealthKeyInvalidError for a ${label}`, async () => {
        await expect(
          computeTxidBlindIndex(TXID_A, key),
        ).rejects.toBeInstanceOf(StealthKeyInvalidError);
      });
    }
  });
});

describe("computeTxidBlindIndex", () => {
  it("returns a stable 64-char hex string for the same txid + key", async () => {
    const key = randomKeyB64();
    const a = await computeTxidBlindIndex(TXID_A, key);
    const b = await computeTxidBlindIndex(TXID_A, key);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs across txids under one key", async () => {
    const key = randomKeyB64();
    const a = await computeTxidBlindIndex(TXID_A, key);
    const b = await computeTxidBlindIndex(TXID_B, key);
    expect(a).not.toBe(b);
  });

  /**
   * The blind index is only blind because the subkey is per (user, app).
   * If two users could ever produce the same index for the same txid, the
   * server could correlate them, and the field would leak exactly what it
   * exists to hide.
   */
  it("never collides across keys for the same txid", async () => {
    const k1 = randomKeyB64();
    const k2 = randomKeyB64();
    const a = await computeTxidBlindIndex(TXID_A, k1);
    const b = await computeTxidBlindIndex(TXID_A, k2);
    expect(a).not.toBe(b);
  });

  /**
   * Domain separation, pinned. The index must NOT be the raw HMAC of the
   * txid under the sealing key: that is one key doing two jobs, and it is
   * the shape this change exists to remove. Computing the old construction
   * here by hand and asserting the new one differs is what stops it from
   * quietly coming back.
   */
  it("is not the raw HMAC under the sealing key itself", async () => {
    const keyB64 = randomKeyB64();
    const bin = atob(keyB64);
    const raw = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
    const rawBuf = new ArrayBuffer(raw.length);
    new Uint8Array(rawBuf).set(raw);

    const sealingKeyAsHmac = await crypto.subtle.importKey(
      "raw",
      rawBuf,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      sealingKeyAsHmac,
      new TextEncoder().encode(TXID_A),
    );
    let oldConstruction = "";
    const sigBytes = new Uint8Array(sig);
    for (let i = 0; i < sigBytes.length; i++) {
      oldConstruction += sigBytes[i].toString(16).padStart(2, "0");
    }

    const actual = await computeTxidBlindIndex(TXID_A, keyB64);
    expect(actual).not.toBe(oldConstruction);
  });

  /**
   * Refuse, do not normalize. An uppercase or byte-reversed txid that got
   * quietly canonicalized here would produce the right index today and a
   * different one the moment another call site chose differently, and the
   * only symptom would be duplicate rows that look real.
   */
  describe("refuses a non-canonical txid", () => {
    const badTxids: Array<[string, string]> = [
      ["uppercase hex", TXID_A.toUpperCase()],
      ["mixed case", TXID_A.slice(0, 63) + TXID_A.slice(63).toUpperCase()],
      ["63 chars", TXID_A.slice(0, 63)],
      ["65 chars", TXID_A + "a"],
      ["non-hex chars", "z".repeat(64)],
      ["empty string", ""],
      ["0x-prefixed", "0x" + TXID_A.slice(2)],
    ];

    for (const [label, txid] of badTxids) {
      it(`throws StealthTxidInvalidError for ${label}`, async () => {
        await expect(
          computeTxidBlindIndex(txid, randomKeyB64()),
        ).rejects.toBeInstanceOf(StealthTxidInvalidError);
      });
    }

    it("throws StealthTxidInvalidError for a non-string txid", async () => {
      await expect(
        computeTxidBlindIndex(
          undefined as unknown as string,
          randomKeyB64(),
        ),
      ).rejects.toBeInstanceOf(StealthTxidInvalidError);
    });
  });
});
