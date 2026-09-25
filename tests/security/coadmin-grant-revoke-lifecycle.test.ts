/**
 * OR-T2462: real authenticated-app-path co-admin grant + revoke, with the
 * workspace_admins row proven to appear and then disappear.
 *
 * WHAT THIS PROVES, AND WHY A MOCKED CLIENT CANNOT. grantCoAdmin and
 * revokeCoAdmin are the exact functions the app UI calls (src/lib/co-admin.ts).
 * Both are guarded by RLS and by a SECURITY DEFINER RPC
 * (allocate_workspace_key) that only a real authenticated session can invoke
 * meaningfully. A mocked Supabase client has no RLS and no server-side
 * allocation, so a unit test built on one cannot show the workspace_admins
 * row actually being written or removed by Postgres -- it can only show the
 * two functions called their mock in the right order. This test drives both
 * functions against a live dev Supabase project with two freshly-created,
 * disposable auth users and reads workspace_admins back with a service-role
 * client before and after each step, which is the same "row appears, row
 * disappears" proof a human would get by watching the table in the Supabase
 * dashboard while clicking the real grant/revoke buttons in the app.
 *
 * WHY NOT PLAYWRIGHT. The product's real UI path requires a signed-up,
 * unlocked vault (Argon2id password entry, PQC keypair generation) before
 * "add a co-admin" is even reachable, and no Playwright spec in this repo
 * drives that flow yet -- building it would be a separate, much larger piece
 * of e2e infrastructure. This file instead follows the pattern this repo
 * already uses and already shipped for the same class of problem: OR-T1114
 * (tests/security/coadmin-workspace-key-allocation.test.ts) and OR-21
 * (tests/security/rls.test.ts) both call the real, non-mocked library
 * functions against a real dev database under a real Supabase Auth session,
 * specifically because vault/co-admin material is ship_rules HIGH risk and
 * is never allowed to be wired as a CI secret (see those files' own headers).
 * A Playwright spec here would still end up needing these same three
 * dev-project keys; it would not remove the credential requirement, only
 * move it into a browser.
 *
 * WHY FRESH USERS, NOT A PROVISIONED ACCOUNT. auth.admin.createUser (service
 * role) mints brand-new, disposable dev accounts at test time, so this file
 * needs no pre-provisioned per-user credential at all -- only the three
 * project-level dev keys below, which is the same requirement the two
 * sibling files already carry.
 *
 * This is a live-database test. It requires three environment variables:
 *   ORANGERAILS_TEST_SUPABASE_URL         - dev Supabase project URL
 *   ORANGERAILS_TEST_SERVICE_ROLE_KEY     - service-role key (fixture setup)
 *   ORANGERAILS_TEST_ANON_KEY             - anon/public key (user sign-in)
 *
 * Run manually against dev (never in CI; no Supabase credentials live in CI):
 *   ORANGERAILS_TEST_SUPABASE_URL=... \
 *   ORANGERAILS_TEST_SERVICE_ROLE_KEY=... \
 *   ORANGERAILS_TEST_ANON_KEY=... \
 *   bunx vitest run tests/security/coadmin-grant-revoke-lifecycle.test.ts
 *
 * It creates two ephemeral users and deletes them again in afterAll. It
 * writes and then removes one workspace_admins row and one wrapped_data_keys
 * row. It never touches an existing account.
 */

import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { grantCoAdmin, revokeCoAdmin } from '@/lib/co-admin';
import { derivePqcSecretWrapKey, deriveVerifierKey } from '@/lib/key-derivation';
import { buildPqcKeyMaterial } from '@/lib/pqc-lifecycle';
import {
  createVaultVerifier,
  deriveMekRaw,
  generateVaultSalt,
  importMekAsHkdf,
} from '@/lib/vault';

const SUPABASE_URL = process.env.ORANGERAILS_TEST_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.ORANGERAILS_TEST_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.ORANGERAILS_TEST_ANON_KEY;

const RUN = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);

// Same silent-success trap as the sibling live-DB files: without this,
// describe.runIf(RUN) registers 0 tests and CI (which never has these
// secrets) would report PASS having proven nothing. Keep the file visible.
if (!RUN) {
  test.skip(
    'OR-T2462 co-admin grant/revoke lifecycle SKIPPED: set ORANGERAILS_TEST_SUPABASE_URL, ' +
      'ORANGERAILS_TEST_SERVICE_ROLE_KEY, and ORANGERAILS_TEST_ANON_KEY to run against dev',
    () => {},
  );
}

/** Argon2id is deliberately slow; every test here pays for at least one run. */
const SLOW = 120_000;

describe.runIf(RUN)('OR-T2462: co-admin grant then revoke, workspace_admins proof', () => {
  const admin = RUN
    ? createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
    : (null as never);

  const anonBase = RUN
    ? createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } })
    : (null as never);

  const fixture = {
    ownerId: '',
    targetId: '',
    ownerPassword: '',
    ownerSaltB64: '',
    ownerVerifierCiphertext: '',
    ownerMek: null as CryptoKey | null,
    ownerSigSecretWrapped: '',
    targetKemPubB64: '',
    ownerClient: null as ReturnType<typeof createClient> | null,
    workspaceKeyId: '',
  };

  /**
   * Build one v1 vault row for a user, exactly as signup would except for the
   * key version. Returns the material a caller needs to act as that user,
   * including the unlocked MEK itself -- grantCoAdmin (post OR-T1889) takes
   * the MEK directly rather than re-deriving it, so the fixture must hand it
   * back rather than only the salt and password.
   */
  async function seedV1Vault(userId: string, password: string) {
    const saltB64 = generateVaultSalt();
    const mekRaw = await deriveMekRaw(password, saltB64);
    const mek = await importMekAsHkdf(mekRaw);
    const verifierCiphertext = await createVaultVerifier(await deriveVerifierKey(mek, saltB64));

    const { error: insErr } = await admin.from('user_vault_meta').insert({
      user_id: userId,
      vault_salt: saltB64,
      vault_verifier_ciphertext: verifierCiphertext,
      vault_key_version: 1,
    });
    if (insErr) throw new Error(`Seed vault row failed: ${insErr.message}`);

    const pqc = await buildPqcKeyMaterial(await derivePqcSecretWrapKey(mek, saltB64));
    const { error: pqcErr } = await admin
      .from('user_vault_meta')
      .update(pqc as unknown as Record<string, unknown>)
      .eq('user_id', userId);
    if (pqcErr) throw new Error(`Seed PQC material failed: ${pqcErr.message}`);

    return {
      saltB64,
      mek,
      verifierCiphertext,
      kemPublicKey: pqc.kem_public_key,
      sigSecretWrapped: pqc.sig_secret_wrapped,
    };
  }

  async function signedInClient(email: string, password: string) {
    const { data, error } = await anonBase.auth.signInWithPassword({ email, password });
    if (error || !data.session) throw new Error(`Sign in ${email} failed: ${error?.message}`);
    return createClient(SUPABASE_URL!, ANON_KEY!, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
    });
  }

  async function workspaceAdminRow() {
    const { data, error } = await admin
      .from('workspace_admins')
      .select('owner_user_id, admin_user_id')
      .eq('owner_user_id', fixture.ownerId)
      .eq('admin_user_id', fixture.targetId);
    if (error) throw new Error(`Read workspace_admins failed: ${error.message}`);
    return data ?? [];
  }

  beforeAll(async () => {
    const tag = String(Date.now());
    const accountPassword = `AcctT2462-${tag}`;
    fixture.ownerPassword = `VaultT2462-${tag}`;

    const emails = {
      owner: `t2462-owner-${tag}@orangerails-test.invalid`,
      target: `t2462-target-${tag}@orangerails-test.invalid`,
    };

    for (const [key, email] of Object.entries(emails)) {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password: accountPassword,
        email_confirm: true,
      });
      if (error || !data.user) throw new Error(`Create ${key} failed: ${error?.message}`);
      if (key === 'owner') fixture.ownerId = data.user.id;
      if (key === 'target') fixture.targetId = data.user.id;
    }

    const owner = await seedV1Vault(fixture.ownerId, fixture.ownerPassword);
    fixture.ownerSaltB64 = owner.saltB64;
    fixture.ownerMek = owner.mek;
    fixture.ownerVerifierCiphertext = owner.verifierCiphertext;
    if (!owner.sigSecretWrapped) throw new Error('Fixture owner has no sig_secret_wrapped');
    fixture.ownerSigSecretWrapped = owner.sigSecretWrapped;

    // The recipient needs a vault only for its KEM public key.
    const target = await seedV1Vault(fixture.targetId, `VaultT2462-target-${tag}`);
    fixture.targetKemPubB64 = target.kemPublicKey;

    fixture.ownerClient = await signedInClient(emails.owner, accountPassword);
  }, SLOW);

  afterAll(async () => {
    // Deleting the auth users cascades the vault, wrapped-key and admin-list
    // rows, so nothing this test wrote outlives it.
    for (const id of [fixture.ownerId, fixture.targetId]) {
      if (id) await admin.auth.admin.deleteUser(id);
    }
  }, SLOW);

  test('workspace_admins has no row for this pair before granting', async () => {
    expect(await workspaceAdminRow()).toHaveLength(0);
  });

  test(
    'grantCoAdmin (the real app function) makes the workspace_admins row appear',
    async () => {
      const result = await grantCoAdmin({
        ownerUserId: fixture.ownerId,
        ownerSaltB64: fixture.ownerSaltB64,
        ownerPassword: fixture.ownerPassword,
        ownerVerifierCiphertext: fixture.ownerVerifierCiphertext,
        ownerKeyVersion: 1,
        ownerEncMekCiphertext: null,
        vaultMek: fixture.ownerMek!,
        ownerSigSecretWrapped: fixture.ownerSigSecretWrapped,
        targetUserId: fixture.targetId,
        targetKemPubB64: fixture.targetKemPubB64,
        existingKeyId: null,
        supabase: fixture.ownerClient as unknown as Parameters<typeof grantCoAdmin>[0]['supabase'],
      });

      fixture.workspaceKeyId = result.workspaceKeyId;
      expect(typeof fixture.workspaceKeyId).toBe('string');
      expect(fixture.workspaceKeyId.length).toBeGreaterThan(0);

      // THE PROOF: read workspace_admins back with the service-role client,
      // independent of the client that made the change.
      const rows = await workspaceAdminRow();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        owner_user_id: fixture.ownerId,
        admin_user_id: fixture.targetId,
      });
    },
    SLOW,
  );

  test(
    'revokeCoAdmin (the real app function) makes the workspace_admins row disappear',
    async () => {
      await revokeCoAdmin({
        ownerWorkspaceKeyId: fixture.workspaceKeyId,
        adminUserId: fixture.targetId,
        ownerUserId: fixture.ownerId,
        supabase: fixture.ownerClient as unknown as Parameters<typeof revokeCoAdmin>[0]['supabase'],
      });

      // THE PROOF: the row that appeared in the previous test is gone.
      expect(await workspaceAdminRow()).toHaveLength(0);

      // And the wrapped key that actually grants access is gone too -- the
      // row disappearing without the key disappearing would be a revoke that
      // only tidied the list and left access intact.
      const { data: wdkRows, error: wdkErr } = await admin
        .from('wrapped_data_keys')
        .select('data_key_id')
        .eq('data_key_id', fixture.workspaceKeyId)
        .eq('recipient_user_id', fixture.targetId);
      expect(wdkErr).toBeNull();
      expect(wdkRows ?? []).toHaveLength(0);
    },
    SLOW,
  );
});
