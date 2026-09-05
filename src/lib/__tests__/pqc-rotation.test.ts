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
import {
  buildPqcKeyMaterial,
  unwrapPqcSecretKey,
  rewrapPqcSecretKey,
  carryPqcSecretsAcrossRotation,
  isAuthenticationTagFailure,
} from "../pqc-lifecycle";

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
    expect(rewrappedKem.status).toBe("rewrapped");
    expect(rewrappedSig.status).toBe("rewrapped");
    if (rewrappedKem.status !== "rewrapped" || rewrappedSig.status !== "rewrapped") return;

    // The assertion the whole ticket is about: after the rotation the secrets
    // are still readable, and they are the SAME secrets. A re-wrap that
    // produced different bytes would leave the stored public keys useless.
    expect(await unwrapPqcSecretKey(after.wrapKey, rewrappedKem.secretWrapped)).toEqual(kemSecret);
    expect(await unwrapPqcSecretKey(after.wrapKey, rewrappedSig.secretWrapped)).toEqual(sigSecret);
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

  it("reports a secret the old key cannot open as dead, rather than throwing", async () => {
    // This test is deliberately inverted from what it used to assert. Throwing
    // here aborted the whole recovery, and that abort was permanent rather than
    // cautious: the state is static, so the same ciphertext and the same
    // discarded MEK failed again on every retry. The recovery code is the
    // user's last way in, so one unreadable keypair took the vault with it.
    const saltB64 = generateVaultSalt();
    const before = await mekWithPqcWrapKey(saltB64);
    const after = await mekWithPqcWrapKey(saltB64);
    const unrelated = await mekWithPqcWrapKey(saltB64);

    const stored = await buildPqcKeyMaterial(before.wrapKey);

    const result = await rewrapPqcSecretKey(
      unrelated.wrapKey,
      after.wrapKey,
      stored.kem_secret_wrapped,
    );

    expect(result).toEqual({ status: "dead" });
  });

  it("still throws when the failure is transient and not a tag check", async () => {
    // The test that stops this fix becoming the destruction it prevents. A
    // transient failure treated as a dead key discards a keypair that is alive.
    // Ordering is what makes throwing safe here: the re-wrap runs before any row
    // is migrated, so aborting costs the user nothing, and every stored wrapper
    // is still valid.
    const saltB64 = generateVaultSalt();
    const before = await mekWithPqcWrapKey(saltB64);
    const after = await mekWithPqcWrapKey(saltB64);
    const stored = await buildPqcKeyMaterial(before.wrapKey);

    // Too short to be AES-GCM output at all. The length guard raises a plain
    // Error before crypto.subtle.decrypt is ever reached.
    await expect(rewrapPqcSecretKey(before.wrapKey, after.wrapKey, "AAAA")).rejects.toBeTruthy();

    // A key that cannot decrypt. WebCrypto raises InvalidAccessError, which is a
    // failure of the layer and says nothing about whether the ciphertext is
    // readable.
    const encryptOnlyKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(32),
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );
    await expect(
      rewrapPqcSecretKey(encryptOnlyKey, after.wrapKey, stored.kem_secret_wrapped),
    ).rejects.toBeTruthy();
  });

  it("recognises only the AES-GCM tag failure as dead", async () => {
    // Pins the discriminator itself. Widen it to any DOMException, or move it
    // onto a message match, and the transient test above starts passing for the
    // wrong reason.
    expect(isAuthenticationTagFailure({ name: "OperationError" })).toBe(true);
    expect(isAuthenticationTagFailure({ name: "InvalidCharacterError" })).toBe(false);
    expect(isAuthenticationTagFailure({ name: "InvalidAccessError" })).toBe(false);
    expect(isAuthenticationTagFailure(new Error("decrypt failed"))).toBe(false);
    expect(isAuthenticationTagFailure(null)).toBe(false);
    expect(isAuthenticationTagFailure("OperationError")).toBe(false);
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
    expect(rewrapped.status).toBe("rewrapped");
    if (rewrapped.status !== "rewrapped") return;

    expect(rewrapped.secretWrapped).not.toBe(stored.kem_secret_wrapped);
    expect(await unwrapPqcSecretKey(before.wrapKey, rewrapped.secretWrapped)).toEqual(secret);
  });
});

describe("vault recovery: carrying both PQC secrets across the rotation", () => {
  it("carries both when both open, and reports nothing replaced", async () => {
    // The happy path, unchanged. This is the regression guard: a change that
    // starts discarding keys on a healthy recovery fails here first.
    const saltB64 = generateVaultSalt();
    const before = await mekWithPqcWrapKey(saltB64);
    const after = await mekWithPqcWrapKey(saltB64);

    const stored = await buildPqcKeyMaterial(before.wrapKey);
    const kemSecret = await unwrapPqcSecretKey(before.wrapKey, stored.kem_secret_wrapped);
    const sigSecret = await unwrapPqcSecretKey(before.wrapKey, stored.sig_secret_wrapped);

    const carried = await carryPqcSecretsAcrossRotation({
      oldWrapKey: before.wrapKey,
      newWrapKey: after.wrapKey,
      oldMek: before.mek,
      authenticatedSaltB64: saltB64,
      kemSecretWrapped: stored.kem_secret_wrapped,
      sigSecretWrapped: stored.sig_secret_wrapped,
    });

    expect(carried.pqcKeysReplaced).toBe(false);
    expect(await unwrapPqcSecretKey(after.wrapKey, carried.newKemSecretWrapped as string)).toEqual(
      kemSecret,
    );
    expect(await unwrapPqcSecretKey(after.wrapKey, carried.newSigSecretWrapped as string)).toEqual(
      sigSecret,
    );
  });

  it("carries the secret that opens and drops only the one that does not", async () => {
    // Mixed is the shape that catches an all-or-nothing implementation. A live
    // signing key has to survive a dead KEM key, and the caller has to be told
    // something was replaced.
    const saltB64 = generateVaultSalt();
    const before = await mekWithPqcWrapKey(saltB64);
    const after = await mekWithPqcWrapKey(saltB64);
    const unrelated = await mekWithPqcWrapKey(saltB64);

    const stored = await buildPqcKeyMaterial(before.wrapKey);
    const deadKem = (await buildPqcKeyMaterial(unrelated.wrapKey)).kem_secret_wrapped;
    const sigSecret = await unwrapPqcSecretKey(before.wrapKey, stored.sig_secret_wrapped);

    const carried = await carryPqcSecretsAcrossRotation({
      oldWrapKey: before.wrapKey,
      newWrapKey: after.wrapKey,
      oldMek: before.mek,
      authenticatedSaltB64: saltB64,
      kemSecretWrapped: deadKem,
      sigSecretWrapped: stored.sig_secret_wrapped,
    });

    expect(carried.newKemSecretWrapped).toBeNull();
    expect(carried.pqcKeysReplaced).toBe(true);
    expect(await unwrapPqcSecretKey(after.wrapKey, carried.newSigSecretWrapped as string)).toEqual(
      sigSecret,
    );
  });

  it("carries nothing and reports nothing replaced when there was nothing stored", async () => {
    // A vault with no PQC keys yet. Nothing was lost, so the recovery screen
    // must NOT tell this user their keys were replaced. The write still clears
    // both public keys, which is what closes the mid-flight backfill race.
    const saltB64 = generateVaultSalt();
    const before = await mekWithPqcWrapKey(saltB64);
    const after = await mekWithPqcWrapKey(saltB64);

    const carried = await carryPqcSecretsAcrossRotation({
      oldWrapKey: before.wrapKey,
      newWrapKey: after.wrapKey,
      oldMek: before.mek,
      authenticatedSaltB64: saltB64,
      kemSecretWrapped: null,
      sigSecretWrapped: null,
    });

    expect(carried).toEqual({
      newKemSecretWrapped: null,
      newSigSecretWrapped: null,
      pqcKeysReplaced: false,
    });
  });

  it("rejects on a transient failure, so the recovery aborts before anything is written", async () => {
    // The carry runs at step 5 of recoverWithCode, before the new envelopes are
    // built and long before a row is migrated. Rejecting means recoverWithCode
    // never returns, so the recovery page never reaches
    // migrateAndPersistRotatedVault and nothing is written at all.
    const saltB64 = generateVaultSalt();
    const before = await mekWithPqcWrapKey(saltB64);
    const after = await mekWithPqcWrapKey(saltB64);

    await expect(
      carryPqcSecretsAcrossRotation({
        oldWrapKey: before.wrapKey,
        newWrapKey: after.wrapKey,
        oldMek: before.mek,
        authenticatedSaltB64: saltB64,
        kemSecretWrapped: "AAAA",
        sigSecretWrapped: null,
      }),
    ).rejects.toBeTruthy();
  });
});

describe("vault recovery: the old wrap key has to be the right key", () => {
  it("throws instead of reporting dead when the old wrap key came from another salt", async () => {
    // THE TEST THAT COULD NOT EXIST BEFORE. Every case above hands the wrap
    // keys in directly, so a caller side salt mistake was invisible to this
    // suite by construction, and the component that makes the real call has no
    // test harness in this repo. The one line where the mistake would be made
    // was the one line nothing exercised.
    //
    // The scenario is the one a salt rotation would produce: the secret really
    // was sealed under the salt the caller names, and the wrap key handed in
    // came from a different one. Both are the same AES-GCM tag failure from
    // inside, so before the guard this returned pqcKeysReplaced: true and a
    // null secret, and the recovery screen told the user that was expected.
    const authenticatedSalt = generateVaultSalt();
    const otherSalt = generateVaultSalt();

    const mek = await importMekAsHkdf(generateMekBytes());
    const realWrapKey = await derivePqcSecretWrapKey(mek, authenticatedSalt);
    const wrongSaltWrapKey = await derivePqcSecretWrapKey(mek, otherSalt);
    const after = await mekWithPqcWrapKey(authenticatedSalt);

    // Sealed under the salt the caller names, which is what makes this a live
    // keypair rather than a genuinely dead one.
    const stored = await buildPqcKeyMaterial(realWrapKey);

    // Asserting on the outcome, not on the message. A message match would keep
    // passing if the throw later moved somewhere that no longer protects
    // anything, which is the failure this whole file exists to prevent.
    await expect(
      carryPqcSecretsAcrossRotation({
        oldWrapKey: wrongSaltWrapKey,
        newWrapKey: after.wrapKey,
        oldMek: mek,
        authenticatedSaltB64: authenticatedSalt,
        kemSecretWrapped: stored.kem_secret_wrapped,
        sigSecretWrapped: stored.sig_secret_wrapped,
      }),
    ).rejects.toBeTruthy();

    // And the secrets are untouched: still readable under the key they were
    // really sealed with. Throwing is only safe because nothing was written.
    expect(await unwrapPqcSecretKey(realWrapKey, stored.kem_secret_wrapped)).toBeTruthy();
    expect(await unwrapPqcSecretKey(realWrapKey, stored.sig_secret_wrapped)).toBeTruthy();
  });

  it("checks the key even when there is nothing to carry", async () => {
    // Pins the check as unconditional. A caller whose salt is wrong is wrong
    // whether or not this particular vault holds PQC keys, and an empty vault
    // is the cheapest place to find out. Without this case, a later "skip the
    // check when there is nothing to do" optimisation would look free.
    const authenticatedSalt = generateVaultSalt();
    const otherSalt = generateVaultSalt();

    const mek = await importMekAsHkdf(generateMekBytes());
    const wrongSaltWrapKey = await derivePqcSecretWrapKey(mek, otherSalt);
    const after = await mekWithPqcWrapKey(authenticatedSalt);

    await expect(
      carryPqcSecretsAcrossRotation({
        oldWrapKey: wrongSaltWrapKey,
        newWrapKey: after.wrapKey,
        oldMek: mek,
        authenticatedSaltB64: authenticatedSalt,
        kemSecretWrapped: null,
        sigSecretWrapped: null,
      }),
    ).rejects.toBeTruthy();
  });

  it("accepts the key the named salt really produces", async () => {
    // The other half, without which the two cases above would also pass if the
    // guard simply rejected everything. Same MEK, same salt, a key derived
    // independently rather than the same object: the check has to pass on
    // equality of the derived key, not on identity of the reference.
    const saltB64 = generateVaultSalt();
    const mek = await importMekAsHkdf(generateMekBytes());
    const wrapKeyA = await derivePqcSecretWrapKey(mek, saltB64);
    const wrapKeyB = await derivePqcSecretWrapKey(mek, saltB64);
    const after = await mekWithPqcWrapKey(saltB64);

    const stored = await buildPqcKeyMaterial(wrapKeyA);
    const kemSecret = await unwrapPqcSecretKey(wrapKeyA, stored.kem_secret_wrapped);

    const carried = await carryPqcSecretsAcrossRotation({
      oldWrapKey: wrapKeyB,
      newWrapKey: after.wrapKey,
      oldMek: mek,
      authenticatedSaltB64: saltB64,
      kemSecretWrapped: stored.kem_secret_wrapped,
      sigSecretWrapped: null,
    });

    expect(carried.pqcKeysReplaced).toBe(false);
    expect(await unwrapPqcSecretKey(after.wrapKey, carried.newKemSecretWrapped as string)).toEqual(
      kemSecret,
    );
  });

  it("rejects a wrap key that is not derived from this MEK at all", async () => {
    // Same salt, different MEK. The salt rotation is the failure I expect, but
    // the guard is really about the key being the right key, and a swapped MEK
    // is the same class of mistake with the same silent consequence.
    const saltB64 = generateVaultSalt();
    const mek = await importMekAsHkdf(generateMekBytes());
    const otherMek = await importMekAsHkdf(generateMekBytes());
    const otherMekWrapKey = await derivePqcSecretWrapKey(otherMek, saltB64);
    const after = await mekWithPqcWrapKey(saltB64);

    await expect(
      carryPqcSecretsAcrossRotation({
        oldWrapKey: otherMekWrapKey,
        newWrapKey: after.wrapKey,
        oldMek: mek,
        authenticatedSaltB64: saltB64,
        kemSecretWrapped: null,
        sigSecretWrapped: null,
      }),
    ).rejects.toBeTruthy();
  });
});
