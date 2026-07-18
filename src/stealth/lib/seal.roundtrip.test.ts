import { describe, it, expect } from "vitest";
import {
  sealEnvelope,
  unsealEnvelope,
  computeTxidBlindIndex,
  computeConnectionBlindIndex,
  StealthKeyMissingError,
  StealthKeyInvalidError,
  StealthTxidInvalidError,
} from "./seal";

/** Generate a fresh random 32-byte key encoded as standard base64. */
function freshKey(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (let i = 0; i < raw.length; i++) bin += String.fromCharCode(raw[i]);
  return btoa(bin);
}

/** A canonical txid: 64 lowercase hex chars. */
const CANONICAL_TXID = "ab".repeat(32);

/** A plausible xpub string for connection index tests. */
const XPUB =
  "xpub6CUGRUonZSQ4TWLx2CE79SGLzLRGRZqMC31HMbaSYQfVnGnH44Gg4FUqgVNGrS3vWvGKFsHrKmTEMFKq7QLcf3mGhekzBo1pZnEFdBvNb1";

// ---- sealEnvelope / unsealEnvelope ----------------------------------------

describe("sealEnvelope / unsealEnvelope", () => {
  it("round-trips a payload under the same key", async () => {
    const key = freshKey();
    const payload = { amount: 21_000_000, note: "genesis" };
    const env = await sealEnvelope(payload, key);
    const out = await unsealEnvelope<typeof payload>(env, key);
    expect(out).toEqual(payload);
  });

  it("produces a fresh IV for each call", async () => {
    const key = freshKey();
    const a = await sealEnvelope({ x: 1 }, key);
    const b = await sealEnvelope({ x: 1 }, key);
    expect(a.iv_b64).not.toBe(b.iv_b64);
  });

  it("refuses to unseal under a different key", async () => {
    const key1 = freshKey();
    const key2 = freshKey();
    const env = await sealEnvelope({ secret: "satoshi" }, key1);
    await expect(unsealEnvelope(env, key2)).rejects.toThrow();
  });

  it("refuses a tampered ciphertext (single flipped byte)", async () => {
    const key = freshKey();
    const env = await sealEnvelope({ data: "utxo" }, key);
    // Flip the first byte of the ciphertext to break the AES-GCM auth tag.
    const raw = atob(env.ciphertext_b64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    bytes[0] ^= 0x01;
    let flipped = "";
    for (let i = 0; i < bytes.length; i++)
      flipped += String.fromCharCode(bytes[i]);
    const tampered = { ...env, ciphertext_b64: btoa(flipped) };
    await expect(unsealEnvelope(tampered, key)).rejects.toThrow();
  });

  it("throws StealthKeyMissingError when keyB64 is empty", async () => {
    await expect(sealEnvelope({}, "")).rejects.toBeInstanceOf(
      StealthKeyMissingError,
    );
  });

  it("throws StealthKeyInvalidError when the key is not 32 bytes", async () => {
    const shortKey = btoa("tooshort"); // 8 bytes decoded, not 32
    await expect(sealEnvelope({}, shortKey)).rejects.toBeInstanceOf(
      StealthKeyInvalidError,
    );
  });
});

// ---- computeTxidBlindIndex ------------------------------------------------

describe("computeTxidBlindIndex", () => {
  it("is stable: same (txid, key) always produces the same index", async () => {
    const key = freshKey();
    const a = await computeTxidBlindIndex(CANONICAL_TXID, key);
    const b = await computeTxidBlindIndex(CANONICAL_TXID, key);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs by key: same txid under different keys yields different indexes", async () => {
    const k1 = freshKey();
    const k2 = freshKey();
    const a = await computeTxidBlindIndex(CANONICAL_TXID, k1);
    const b = await computeTxidBlindIndex(CANONICAL_TXID, k2);
    expect(a).not.toBe(b);
  });

  it("throws StealthTxidInvalidError for a non-canonical txid", async () => {
    await expect(
      computeTxidBlindIndex("NOTCANONICAL", freshKey()),
    ).rejects.toBeInstanceOf(StealthTxidInvalidError);
  });
});

// ---- computeConnectionBlindIndex ------------------------------------------

describe("computeConnectionBlindIndex", () => {
  it("is stable: same (wallet, key) always produces the same index", async () => {
    const key = freshKey();
    const a = await computeConnectionBlindIndex(XPUB, key);
    const b = await computeConnectionBlindIndex(XPUB, key);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs by key: same wallet under different keys yields different indexes", async () => {
    const k1 = freshKey();
    const k2 = freshKey();
    const a = await computeConnectionBlindIndex(XPUB, k1);
    const b = await computeConnectionBlindIndex(XPUB, k2);
    expect(a).not.toBe(b);
  });
});
