/**
 * Tests for assertMekEnvelopeReopens in src/lib/vault.ts.
 *
 * WHY THESE EXIST. Wrapping the MEK is write-only: wrapMekBytes returns a
 * string and, until this check, nothing ever confirmed the string could be
 * opened again. On the password-change path both wrappers are written in one
 * statement and the old ones are discarded, so a wrap that came out wrong is a
 * permanent lockout with no server-side copy of the key to restore from.
 *
 * The property being pinned is that the check has two halves and they catch
 * different things. The unwrap catches a corrupt envelope or the wrong key,
 * because AES-GCM authenticates. The byte compare catches an envelope that
 * opens cleanly and carries the wrong plaintext, which authentication cannot
 * see. Someone will eventually read the compare as redundant; these tests are
 * the answer.
 *
 * Real crypto, no mocks. AES-GCM only, so no Argon2 work factor is involved
 * and the file runs fast.
 */

import { describe, it, expect } from "vitest";
import { assertMekEnvelopeReopens, generateMekBytes, wrapMekBytes } from "../vault";

async function makeWrappingKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Flip one bit in the last byte of the envelope. encryptString emits
 * base64(IV[12] || ciphertext || tag[16]), so the last byte is inside the
 * authentication tag and the unwrap is guaranteed to fail, not merely likely
 * to.
 */
function corrupt(envelopeB64: string): string {
  const bytes = Uint8Array.from(atob(envelopeB64), (c) => c.charCodeAt(0));
  bytes[bytes.length - 1] ^= 0x01;
  return btoa(String.fromCharCode(...bytes));
}

describe("assertMekEnvelopeReopens", () => {
  it("resolves for an envelope that really does re-open to the given bytes", async () => {
    const mekRaw = generateMekBytes();
    const kek = await makeWrappingKey();
    const envelope = await wrapMekBytes(mekRaw, kek);

    await expect(
      assertMekEnvelopeReopens("The envelope", envelope, kek, mekRaw),
    ).resolves.toBeUndefined();
  });

  it("throws when the envelope has been corrupted", async () => {
    const mekRaw = generateMekBytes();
    const kek = await makeWrappingKey();
    const envelope = corrupt(await wrapMekBytes(mekRaw, kek));

    await expect(
      assertMekEnvelopeReopens("The envelope", envelope, kek, mekRaw),
    ).rejects.toThrow("could not be re-opened");
  });

  it("throws when the envelope is not garbage but the key is the wrong one", async () => {
    const mekRaw = generateMekBytes();
    const kek = await makeWrappingKey();
    const otherKek = await makeWrappingKey();
    const envelope = await wrapMekBytes(mekRaw, kek);

    await expect(
      assertMekEnvelopeReopens("The envelope", envelope, otherKek, mekRaw),
    ).rejects.toThrow("could not be re-opened");
  });

  it("throws a DIFFERENT error when it opens cleanly but carries other key material", async () => {
    // This is the case the unwrap cannot see. The envelope is well formed and
    // authenticates under this key; it simply wraps the wrong MEK. Without the
    // byte compare this would pass and the user would be handed a working
    // recovery code for a key that opens none of their data.
    const intendedMek = generateMekBytes();
    const someOtherMek = generateMekBytes();
    const kek = await makeWrappingKey();
    const envelope = await wrapMekBytes(someOtherMek, kek);

    await expect(
      assertMekEnvelopeReopens("The envelope", envelope, kek, intendedMek),
    ).rejects.toThrow("re-opened to different key material");
  });

  it("throws when the wrapped bytes are a prefix of the expected ones", async () => {
    // Length is checked before the comparison, so a truncated MEK cannot pass
    // by matching on the bytes it does have.
    const mekRaw = generateMekBytes();
    const kek = await makeWrappingKey();
    const envelope = await wrapMekBytes(mekRaw.slice(0, 16), kek);

    await expect(
      assertMekEnvelopeReopens("The envelope", envelope, kek, mekRaw),
    ).rejects.toThrow("re-opened to different key material");
  });

  it("names the envelope in the error, so the user is told which one failed", async () => {
    const mekRaw = generateMekBytes();
    const kek = await makeWrappingKey();
    const envelope = corrupt(await wrapMekBytes(mekRaw, kek));

    await expect(
      assertMekEnvelopeReopens("The new recovery code envelope", envelope, kek, mekRaw),
    ).rejects.toThrow("The new recovery code envelope");
  });
});
