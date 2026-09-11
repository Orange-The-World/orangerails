/**
 * Direct unit tests for assertMekEnvelopeReopens (src/lib/vault.ts).
 *
 * WHY THIS EXISTS. assertMekEnvelopeReopens is what stands between a
 * password or recovery-code change and a permanently unreadable vault: it
 * is the only thing that proves a stored envelope actually opens back up to
 * the key it was supposed to hold. Until now it was exercised only through
 * a fake verifier in vault-persist.test.ts, which proves the CALLER wires
 * it in correctly and proves nothing about whether the helper itself is
 * correct. These tests use real WebCrypto end to end: a real wrap, a real
 * unwrap, a real AES-GCM authentication failure.
 *
 * THE CASE THAT MATTERS is the third one below. AES-GCM authentication
 * catches a wrong key or a corrupted envelope on its own. It cannot catch
 * an envelope that authenticates cleanly but was wrapped around the wrong
 * plaintext, because authentication only proves the bytes were not
 * tampered with after wrapping, not that they were the right bytes to
 * begin with. Only the byte compare inside assertMekEnvelopeReopens catches
 * that, and if the byte compare were ever deleted, every other test in this
 * suite (and in vault-persist.test.ts) would still pass.
 */

import { webcrypto } from "node:crypto";

// vitest.config.ts runs this suite with environment "node". Node has carried
// a global `crypto` with `.subtle` since v19, but this repo does not pin a
// node version for the vitest job (only Bun is pinned), so do not assume
// either way: install the real WebCrypto implementation only if nothing is
// already there.
if (!globalThis.crypto?.subtle) {
  (globalThis as unknown as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
}

import { describe, it, expect } from "vitest";
import { assertMekEnvelopeReopens, wrapMekBytes, importAesKey } from "../vault";

async function freshAesKey(): Promise<CryptoKey> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return importAesKey(raw.buffer as ArrayBuffer);
}

function freshMekBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

describe("assertMekEnvelopeReopens", () => {
  it("resolves when an envelope wrapped with key K re-opens under K to the same bytes", async () => {
    const key = await freshAesKey();
    const mek = freshMekBytes();
    const envelope = await wrapMekBytes(mek, key);

    await expect(assertMekEnvelopeReopens("test envelope", envelope, key, mek)).resolves.toBeUndefined();
  });

  it("rejects with 'could not be re-opened' when opened under a different key", async () => {
    const wrappingKey = await freshAesKey();
    const otherKey = await freshAesKey();
    const mek = freshMekBytes();
    const envelope = await wrapMekBytes(mek, wrappingKey);

    // AES-GCM authentication catches this: the wrong key cannot even
    // decrypt the tag, so unwrapMekBytes throws before any byte compare runs.
    await expect(assertMekEnvelopeReopens("test envelope", envelope, otherKey, mek)).rejects.toThrow(
      "test envelope could not be re-opened with the key that wrapped it.",
    );
  });

  it("rejects with 'different key material' when the envelope authenticates cleanly but carries the wrong plaintext", async () => {
    const key = await freshAesKey();
    const expectedMek = freshMekBytes();
    // Wrap 32 bytes that are NOT the expected MEK, under the SAME key. This
    // authenticates perfectly under that key: AES-GCM has no way to know the
    // plaintext is "wrong", only that it was not tampered with. Only the byte
    // compare inside assertMekEnvelopeReopens can catch this.
    const wrongMek = freshMekBytes();
    const envelope = await wrapMekBytes(wrongMek, key);

    await expect(assertMekEnvelopeReopens("test envelope", envelope, key, expectedMek)).rejects.toThrow(
      "test envelope re-opened to different key material than it was given.",
    );
  });

  it("does not treat a length mismatch as equal (bytesEqual short-circuits before the loop)", async () => {
    const key = await freshAesKey();
    const expectedMek = freshMekBytes();
    // 31 bytes, not 32: a short unwrap that happens to share a common prefix
    // with expectedMek must still be rejected, and must not read past the
    // end of the shorter array while comparing.
    const shortWrong = expectedMek.slice(0, 31);
    const envelope = await wrapMekBytes(shortWrong, key);

    await expect(assertMekEnvelopeReopens("test envelope", envelope, key, expectedMek)).rejects.toThrow(
      "test envelope re-opened to different key material than it was given.",
    );
  });
});
