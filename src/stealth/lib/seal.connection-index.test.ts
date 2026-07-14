/**
 * Connection blind index: compatibility and separation.
 *
 * The txid blind index is covered in seal.test.ts. This file covers the other
 * index, the one over the wallet identifier (xpub, ypub, zpub, or output
 * descriptor) that the add route sends so the server can recognize a wallet the
 * user already connected without ever holding the xpub.
 *
 * Why it is a separate file: the property under test here is not a crypto
 * property, it is a compatibility one. Live connection rows were indexed with a
 * specific construction and the function has to keep producing it. That is a
 * different reason to fail than "the guard did not fire", and it deserves to
 * read as its own thing.
 */

import { describe, expect, it } from "vitest";

import {
  computeConnectionBlindIndex,
  computeTxidBlindIndex,
  StealthConnectionInputInvalidError,
  StealthKeyInvalidError,
  StealthKeyMissingError,
  StealthTxidInvalidError,
} from "./seal";

/** A 32-byte key, base64. Fixed so the expected values below are stable. */
const KEY_B64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const OTHER_KEY_B64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

const XPUB =
  "xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz";

const CANONICAL_TXID =
  "3a1b2c4d5e6f70819293a4b5c6d7e8f90112233445566778899aabbccddeeff0";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

/**
 * The construction the live connection rows were written with: HMAC-SHA-256
 * over the identifier, under the master key itself, hex out. Recomputed here by
 * hand so the test fails if the function's derivation ever moves.
 */
async function legacyConstruction(input: string, keyB64: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    b64ToBytes(keyB64),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input));
  return hex(new Uint8Array(sig));
}

describe("computeConnectionBlindIndex", () => {
  it("still produces the construction the live connection rows carry", async () => {
    const expected = await legacyConstruction(XPUB, KEY_B64);
    await expect(computeConnectionBlindIndex(XPUB, KEY_B64)).resolves.toBe(expected);
  });

  it("is deterministic for the same identifier and key", async () => {
    const a = await computeConnectionBlindIndex(XPUB, KEY_B64);
    const b = await computeConnectionBlindIndex(XPUB, KEY_B64);
    expect(a).toBe(b);
  });

  it("never collides across keys for the same identifier", async () => {
    const mine = await computeConnectionBlindIndex(XPUB, KEY_B64);
    const theirs = await computeConnectionBlindIndex(XPUB, OTHER_KEY_B64);
    expect(mine).not.toBe(theirs);
  });

  it("indexes the identifier exactly as given, and never normalizes it", async () => {
    const spaced = await computeConnectionBlindIndex(` ${XPUB}`, KEY_B64);
    const clean = await computeConnectionBlindIndex(XPUB, KEY_B64);
    expect(spaced).not.toBe(clean);
  });

  it("refuses an empty identifier", async () => {
    await expect(computeConnectionBlindIndex("", KEY_B64)).rejects.toBeInstanceOf(
      StealthConnectionInputInvalidError,
    );
  });

  it("refuses a missing key before any crypto runs", async () => {
    await expect(
      computeConnectionBlindIndex(XPUB, undefined as unknown as string),
    ).rejects.toBeInstanceOf(StealthKeyMissingError);
  });

  it("refuses a key that is not 32 bytes", async () => {
    const short = btoa(String.fromCharCode(...new Uint8Array(31).fill(7)));
    await expect(computeConnectionBlindIndex(XPUB, short)).rejects.toBeInstanceOf(
      StealthKeyInvalidError,
    );
  });
});

describe("the two indexes are not interchangeable", () => {
  it("refuses an xpub handed to the txid index", async () => {
    // This is the bug: the add route indexes a wallet identifier, not a txid.
    // Pointing it at the txid function compiles and then throws on every add.
    await expect(computeTxidBlindIndex(XPUB, KEY_B64)).rejects.toBeInstanceOf(
      StealthTxidInvalidError,
    );
  });

  it("produces different values for the same input under the same key", async () => {
    // Domain separation, made visible: the txid index runs under an HKDF
    // subkey, the connection index under the master. Same bytes in, different
    // bytes out, or the subkey is not being derived.
    const asTxid = await computeTxidBlindIndex(CANONICAL_TXID, KEY_B64);
    const asConnection = await computeConnectionBlindIndex(CANONICAL_TXID, KEY_B64);
    expect(asTxid).not.toBe(asConnection);
  });
});
