/**
 * Sealed-envelope round-trip and blind-index tests.
 *
 * Runs under Vitest's node environment. Node 20 has Web Crypto as a
 * global (`globalThis.crypto`), so the same code paths run in tests as
 * in the browser.
 */

import { describe, expect, it } from "vitest";

import { blindIndex, sealEnvelope, unsealEnvelope } from "./seal";

function randomKeyB64(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (let i = 0; i < raw.length; i++) s += String.fromCharCode(raw[i]);
  return btoa(s);
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
