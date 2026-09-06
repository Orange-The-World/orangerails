/**
 * Tests for buildRewrappedMekEnvelopes: the check that runs BEFORE a vault
 * password change is written.
 *
 * WHY THIS IS A DIFFERENT PROPERTY FROM THE ONE PINNED IN vault-persist.test.ts,
 * and why neither suite makes the other redundant. That one proves the envelopes
 * the DATABASE returned re-open, which catches a write that stored something
 * other than what it was sent. This one proves an envelope that was wrong from
 * the moment it was built never reaches the write at all. Those are different
 * faults, and each check is blind to the other's.
 *
 * Why it matters that the failure lands BEFORE the write: storing the new pair
 * discards the old pair, and there is no server-side copy of the key by design.
 * An unusable envelope caught on the way back is already a permanent lockout.
 * Caught here, the user is exactly where they started.
 *
 * HOW A BROKEN ENVELOPE IS FORCED WITHOUT A TEST SEAM IN SHIPPED CODE. An
 * AES-GCM key imported with only the "encrypt" usage wraps normally and refuses
 * to unwrap. That is real WebCrypto behaviour rather than a stub, so the
 * function exercised here is exactly the one that ships.
 */

import { describe, it, expect, vi } from "vitest";
import { buildRewrappedMekEnvelopes, unwrapMekBytes } from "../vault";
import { persistRewrappedVaultMeta, type RewrapVaultArgs } from "../vault-persist";

/** Stand-in for the MEK being re-wrapped. Its value does not matter, only that it round-trips. */
const MEK_RAW = new Uint8Array(32).fill(7);

async function aesKey(fill: number, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(fill) as BufferSource,
    { name: "AES-GCM" },
    /* extractable */ false,
    usages,
  );
}

/** Wraps and unwraps. A healthy wrapping key. */
function workingKey(fill: number): Promise<CryptoKey> {
  return aesKey(fill, ["encrypt", "decrypt"]);
}

/** Wraps and cannot unwrap. Stands in for an envelope that was built wrong. */
function wrapOnlyKey(fill: number): Promise<CryptoKey> {
  return aesKey(fill, ["encrypt"]);
}

/**
 * The sequence this check exists to protect: build the two envelopes, then hand
 * them to the write. Nothing here is the real database. The point of the test is
 * whether the second step is reached at all.
 */
async function buildThenWrite(params: {
  newKek: CryptoKey;
  newRecoveryKek: CryptoKey;
  persist: (args: RewrapVaultArgs) => Promise<void>;
}): Promise<void> {
  const envelopes = await buildRewrappedMekEnvelopes({
    mekRaw: MEK_RAW,
    newKek: params.newKek,
    newRecoveryKek: params.newRecoveryKek,
  });

  await params.persist({
    supabase: { from: () => ({}) },
    userId: "user-1",
    priorEncMekCiphertext: "prior-envelope",
    newEncMekCiphertext: envelopes.encMekCiphertext,
    newRecoveryCiphertext: envelopes.recoveryCiphertext,
    verifyPersisted: async () => {},
  });
}

describe("buildRewrappedMekEnvelopes", () => {
  it("returns both envelopes when each one re-opens to the MEK it was given", async () => {
    const newKek = await workingKey(1);
    const newRecoveryKek = await workingKey(2);

    const { encMekCiphertext, recoveryCiphertext } = await buildRewrappedMekEnvelopes({
      mekRaw: MEK_RAW,
      newKek,
      newRecoveryKek,
    });

    expect(await unwrapMekBytes(encMekCiphertext, newKek)).toEqual(MEK_RAW);
    expect(await unwrapMekBytes(recoveryCiphertext, newRecoveryKek)).toEqual(MEK_RAW);
  });

  it("throws before the write when the new password envelope cannot be re-opened", async () => {
    const persist = vi.fn<typeof persistRewrappedVaultMeta>();

    await expect(
      buildThenWrite({
        newKek: await wrapOnlyKey(1),
        newRecoveryKek: await workingKey(2),
        persist,
      }),
    ).rejects.toThrow(/password key envelope could not be re-opened/);

    expect(persist).not.toHaveBeenCalled();
  });

  it("throws before the write when the new recovery envelope cannot be re-opened", async () => {
    const persist = vi.fn<typeof persistRewrappedVaultMeta>();

    await expect(
      buildThenWrite({
        newKek: await workingKey(1),
        newRecoveryKek: await wrapOnlyKey(2),
        persist,
      }),
    ).rejects.toThrow(/recovery code envelope could not be re-opened/);

    expect(persist).not.toHaveBeenCalled();
  });

  it("reaches the write when both envelopes re-open", async () => {
    const persist = vi.fn<typeof persistRewrappedVaultMeta>();

    await buildThenWrite({
      newKek: await workingKey(1),
      newRecoveryKek: await workingKey(2),
      persist,
    });

    expect(persist).toHaveBeenCalledTimes(1);
  });
});
