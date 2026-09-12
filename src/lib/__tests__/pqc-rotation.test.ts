/**
 * Do the post-quantum secret keys survive a vault recovery?
 *
 * WHY THIS FILE EXISTS. A recovery is a TRUE MEK rotation: recoverWithCode()
 * mints a fresh random MEK and the write that follows overwrites both wrappers
 * of the old one, so the old MEK becomes unreachable forever. Two columns on
 * user_vault_meta are wrapped under derivePqcSecretWrapKey(mek, salt), which is
 * an HKDF subkey of that MEK: kem_secret_wrapped and sig_secret_wrapped. They
 * are not data rows, so the migration loop that rewrites connections and
 * transactions never sees them.
 *
 * Left behind, they are lost in the worst possible way. Nothing errors at the
 * time. The row still holds a valid looking kem_public_key, so ensurePqcKeypairs
 * short-circuits and never regenerates. Anything encrypted to that public key
 * afterwards is undecryptable from the moment it is written, and the first
 * person to find out is whoever needs it.
 *
 * These tests use real key material and real AES-GCM rather than a stub,
 * because the property is not "a function was called", it is "these exact bytes
 * still decrypt". A faked crypto layer would assert nothing.
 */

import { describe, it, expect } from "vitest";
import { generateMekBytes, importMekAsHkdf, generateVaultSalt } from "../vault";
import { derivePqcSecretWrapKey } from "../key-derivation";
import { buildPqcKeyMaterial, unwrapPqcSecretKey, rewrapPqcSecretKey } from "../pqc-lifecycle";

/** A fresh random MEK plus the PQC wrap key derived from it. */
async function mekWithPqcWrapKey(saltB64: string) {
  const mek = await importMekAsHkdf(generateMekBytes());
  const wrapKey = await derivePqcSecretWrapKey(mek, saltB64);
  return { mek, wrapKey };
}

describe("vault recovery: PQC secret keys across an MEK rotation", () => {
  it("still unwraps both secret keys after the rotation", async () => {
    // The salt is deliberately the same on both sides. A recovery preserves it,
    // and preserving it is exactly what makes this defect easy to miss: the
    // salt not changing reads as "the subkeys are stable", which is false,
    // because every subkey is derived from MEK plus salt and the MEK rotates.
    const saltB64 = generateVaultSalt();
    const before = await mekWithPqcWrapKey(saltB64);
    const after = await mekWithPqcWrapKey(saltB64);

    const stored = await buildPqcKeyMaterial(before.wrapKey);
    const kemSecret = await unwrapPqcSecretKey(before.wrapKey, stored.kem_secret_wrapped);
    const sigSecret = await unwrapPqcSecretKey(before.wrapKey, stored.sig_secret_wrapped);
    expect(kemSecret.length).toBeGreaterThan(0);
    expect(sigSecret.length).toBeGreaterThan(0);

    const rewrappedKem = await rewrapPqcSecretKey(
      before.wrapKey,
      after.wrapKey,
      stored.kem_secret_wrapped,
    );
    const rewrappedSig = await rewrapPqcSecretKey(
      before.wrapKey,
      after.wrapKey,
      stored.sig_secret_wrapped,
    );

    // The assertion the whole ticket is about: after the rotation the secrets
    // are still readable, and they are the SAME secrets. A re-wrap that
    // produced different bytes would leave the stored public keys useless.
    expect(await unwrapPqcSecretKey(after.wrapKey, rewrappedKem)).toEqual(kemSecret);
    expect(await unwrapPqcSecretKey(after.wrapKey, rewrappedSig)).toEqual(sigSecret);
  });

  it("shows the stored wrappers are dead under the rotated MEK if nothing carries them", async () => {
    // This is what gives the test above its meaning. Without it, that test
    // would also pass if the wrap key were somehow reachable from either MEK,
    // and it would then be evidence of nothing.
    const saltB64 = generateVaultSalt();
    const before = await mekWithPqcWrapKey(saltB64);
    const after = await mekWithPqcWrapKey(saltB64);

    const stored = await buildPqcKeyMaterial(before.wrapKey);

    await expect(
      unwrapPqcSecretKey(after.wrapKey, stored.kem_secret_wrapped),
    ).rejects.toBeTruthy();
    await expect(
      unwrapPqcSecretKey(after.wrapKey, stored.sig_secret_wrapped),
    ).rejects.toBeTruthy();
  });

  it("throws rather than returning something unopenable when the old key is wrong", async () => {
    // Ordering matters more than the throw itself. The re-wrap runs before any
    // row is migrated, so a failure here costs the user nothing: every stored
    // wrapper is still valid and the vault still opens. The same failure after
    // the migration loop would leave rows under a MEK with no way back.
    const saltB64 = generateVaultSalt();
    const before = await mekWithPqcWrapKey(saltB64);
    const after = await mekWithPqcWrapKey(saltB64);
    const unrelated = await mekWithPqcWrapKey(saltB64);

    const stored = await buildPqcKeyMaterial(before.wrapKey);

    await expect(
      rewrapPqcSecretKey(unrelated.wrapKey, after.wrapKey, stored.kem_secret_wrapped),
    ).rejects.toBeTruthy();
  });

  it("re-wraps a secret that is handed straight back to the same key", async () => {
    // Guards the encoding. rewrapPqcSecretKey moves the stored base64 string
    // across without round tripping it through bytes, so a change that started
    // decoding it would show up here as a mismatch rather than as a vault
    // nobody can open months later.
    const saltB64 = generateVaultSalt();
    const before = await mekWithPqcWrapKey(saltB64);

    const stored = await buildPqcKeyMaterial(before.wrapKey);
    const secret = await unwrapPqcSecretKey(before.wrapKey, stored.kem_secret_wrapped);

    const rewrapped = await rewrapPqcSecretKey(
      before.wrapKey,
      before.wrapKey,
      stored.kem_secret_wrapped,
    );

    expect(rewrapped).not.toBe(stored.kem_secret_wrapped);
    expect(await unwrapPqcSecretKey(before.wrapKey, rewrapped)).toEqual(secret);
  });
});
