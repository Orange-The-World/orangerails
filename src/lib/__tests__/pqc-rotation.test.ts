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
  ensurePqcKeypairs,
  type SupabaseLike,
  type PqcKeyMaterialRow,
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
        kemSecretWrapped: "AAAA",
        sigSecretWrapped: null,
      }),
    ).rejects.toBeTruthy();
  });
});

describe("ensurePqcKeypairs: the regeneration gate must match the write invariant (OR-T1977)", () => {
  /** A stub SupabaseLike whose select always returns the given row and whose
   * update records what it was called with, so the test can assert on the
   * write instead of only on the return value. */
  function stubSupabase(row: { kem_public_key: string | null; sig_public_key: string | null }) {
    let updateArgs: Record<string, unknown> | null = null;
    const supabase: SupabaseLike = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { ...row }, error: null }),
          }),
        }),
        update: (values: Record<string, unknown>) => ({
          eq: async () => {
            updateArgs = values;
            return { error: null };
          },
        }),
      }),
    };
    return { supabase, getUpdateArgs: () => updateArgs };
  }

  it("repairs a row where kem_public_key survived a rotation and sig_public_key did not", async () => {
    // The exact shape from the Auditor's OR-C1148 challenge: not reachable
    // from this app's own write path today (vault-persist.ts clears both
    // public keys together, OR-T1954), but the gate has to repair it
    // regardless of how it arrived, or the row is broken forever.
    const saltB64 = generateVaultSalt();
    const { mek } = await mekWithPqcWrapKey(saltB64);
    const { supabase, getUpdateArgs } = stubSupabase({
      kem_public_key: "stale-kem-public-key",
      sig_public_key: null,
    });

    const result = await ensurePqcKeypairs({ userId: "u1", mek, saltB64, supabase });

    expect(result.generated).toBe(true);
    const written = getUpdateArgs() as unknown as PqcKeyMaterialRow | null;
    expect(written).not.toBeNull();
    expect(written?.kem_public_key).toBeTruthy();
    expect(written?.sig_public_key).toBeTruthy();
    expect(written?.kem_secret_wrapped).toBeTruthy();
    expect(written?.sig_secret_wrapped).toBeTruthy();
  });

  it("still short-circuits when both public keys are already populated", async () => {
    const saltB64 = generateVaultSalt();
    const { mek } = await mekWithPqcWrapKey(saltB64);
    const { supabase, getUpdateArgs } = stubSupabase({
      kem_public_key: "live-kem-public-key",
      sig_public_key: "live-sig-public-key",
    });

    const result = await ensurePqcKeypairs({ userId: "u1", mek, saltB64, supabase });

    expect(result).toEqual({ generated: false });
    expect(getUpdateArgs()).toBeNull();
  });
});
