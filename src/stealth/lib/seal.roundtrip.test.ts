import { describe, expect, it } from "vitest";

import { blindIndex, sealEnvelope, unsealEnvelope } from "@/stealth/lib/seal";

/** A deterministic 32-byte key, base64, built without hand-encoding it. */
function keyOf(fill: number): string {
  return b64encode(new Uint8Array(32).fill(fill));
}

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const KEY_A = keyOf(0x11);
const KEY_B = keyOf(0x22);

describe("sealEnvelope / unsealEnvelope", () => {
  it("round-trips a payload under the same key", async () => {
    const payload = { txid: "abc123", amount_sats: 21_000, memo: "coffee" };

    const env = await sealEnvelope(payload, KEY_A);
    expect(env.version).toBe(1);
    expect(env.algorithm).toBe("AES-256-GCM");

    const out = await unsealEnvelope<typeof payload>(env, KEY_A);
    expect(out).toEqual(payload);
  });

  it("produces a fresh IV per envelope, so the same payload never seals identically", async () => {
    const payload = { txid: "abc123" };

    const one = await sealEnvelope(payload, KEY_A);
    const two = await sealEnvelope(payload, KEY_A);

    expect(one.iv_b64).not.toBe(two.iv_b64);
    expect(one.ciphertext_b64).not.toBe(two.ciphertext_b64);
  });

  it("refuses to unseal under a different key", async () => {
    const env = await sealEnvelope({ txid: "abc123" }, KEY_A);
    await expect(unsealEnvelope(env, KEY_B)).rejects.toThrow();
  });

  it("refuses a tampered ciphertext instead of decoding it", async () => {
    const env = await sealEnvelope({ txid: "abc123" }, KEY_A);

    const bytes = b64decode(env.ciphertext_b64);
    bytes[0] = bytes[0] ^ 0x01;
    const tampered = { ...env, ciphertext_b64: b64encode(bytes) };

    await expect(unsealEnvelope(tampered, KEY_A)).rejects.toThrow();
  });

  it("refuses a key that is not 32 bytes", async () => {
    const shortKey = b64encode(new Uint8Array(31).fill(0x11));
    await expect(sealEnvelope({ txid: "abc123" }, shortKey)).rejects.toThrow(
      /32 bytes/,
    );
  });
});

describe("blindIndex", () => {
  it("is deterministic for a value under a key", async () => {
    const one = await blindIndex("abc123", KEY_A);
    const two = await blindIndex("abc123", KEY_A);

    expect(one).toBe(two);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs by value and by key, so the server learns neither", async () => {
    const valueA = await blindIndex("abc123", KEY_A);
    const valueB = await blindIndex("def456", KEY_A);
    const underOtherKey = await blindIndex("abc123", KEY_B);

    expect(valueA).not.toBe(valueB);
    expect(valueA).not.toBe(underOtherKey);
  });

  it("refuses a key that is not 32 bytes", async () => {
    const shortKey = b64encode(new Uint8Array(31).fill(0x11));
    await expect(blindIndex("abc123", shortKey)).rejects.toThrow(/32 bytes/);
  });
});
