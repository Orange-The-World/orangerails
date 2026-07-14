/**
 * Sealed-envelope round-trip, key-guard, and blind-index tests.
 *
 * Runs under Vitest's node environment. Node 20 has Web Crypto as a
 * global (`globalThis.crypto`), so the same code paths run in tests as
 * in the browser.
 */

import { describe, expect, it } from "vitest";

import {
  blindIndex,
  sealEnvelope,
  StealthKeyInvalidError,
  StealthKeyMissingError,
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

  describe("blindIndex", () => {
    for (const [label, key] of missingKeys) {
      it(`throws StealthKeyMissingError for a ${label}`, async () => {
        await expect(blindIndex("some-txid", key)).rejects.toBeInstanceOf(
          StealthKeyMissingError,
        );
      });
    }
    for (const [label, key] of invalidKeys) {
      it(`throws StealthKeyInvalidError for a ${label}`, async () => {
        await expect(blindIndex("some-txid", key)).rejects.toBeInstanceOf(
          StealthKeyInvalidError,
        );
      });
    }
  });
});

describe("blindIndex", () => {
  it("returns a stable hex string for the same input + key", async () => {
    const key = randomKeyB64();
    const a = await blindIndex("a1b2c3-txid", key);
    const b = await blindIndex("a1b2c3-txid", key);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs across inputs", async () => {
    const key = randomKeyB64();
    const a = await blindIndex("txid-one", key);
    const b = await blindIndex("txid-two", key);
    expect(a).not.toBe(b);
  });

  it("differs across keys for the same input", async () => {
    const k1 = randomKeyB64();
    const k2 = randomKeyB64();
    const a = await blindIndex("same-txid", k1);
    const b = await blindIndex("same-txid", k2);
    expect(a).not.toBe(b);
  });
});
