/**
 * OR-T1114: grantCoAdmin must take workspace_key_id from the server.
 *
 * WHAT THIS PROVES, AND WHY A UNIT TEST CANNOT.
 * The change under test is that grantCoAdmin stopped minting
 * user_vault_meta.workspace_key_id with crypto.randomUUID() and now calls
 * allocate_workspace_key() instead. What forced that change is a COLUMN
 * PRIVILEGE: the authenticated role no longer holds INSERT or UPDATE on
 * workspace_key_id. A mocked Supabase client has no privileges, so a unit test
 * built on one passes identically before and after the change and proves
 * nothing. The only way to exercise it is a real authenticated session against
 * a real database.
 *
 * THE FOUR ASSERTIONS.
 *   1. The owner genuinely cannot write the column. If this one ever goes
 *      green in the other direction, the privilege came back and the whole
 *      reason for the RPC is gone.
 *   2. grantCoAdmin returns the id the SERVER stored. A locally minted id
 *      would not match the row.
 *   3. The wrapped_data_keys row lands with data_key_id equal to that id.
 *   4. The stored ML-DSA-65 grant signature verifies against that id. This is
 *      the ordering assertion and it is the one worth having: signMemberGrant
 *      binds the workspace key id, and all four signed fields must match at
 *      verify time. If the allocation ever moves to AFTER the signature, the
 *      signature covers a different id, verification fails here, and the bug
 *      is caught at grant time rather than months later as a co-admin who
 *      cannot open anything.
 *
 * Plus the refusal path: a signed-in user with no user_vault_meta row must get
 * an error out of the RPC, not a grant signed against an id nothing holds.
 *
 * WHY THE FIXTURE IS A vault_key_version 1 VAULT.
 * grantCoAdmin derives all of its key material from deriveMekRaw(), which is
 * Argon2id(password, salt). That IS the MEK in a v1 vault. In a v2 vault the
 * MEK is 32 random bytes and the Argon2id output is only the KEK that wraps
 * it, so the value grantCoAdmin derives is not the MEK and the signing step
 * fails when it tries to unwrap sig_secret_wrapped. That is a real defect and
 * it is tracked on its own; it is not what this test is about, and forcing a
 * v2 fixture here would only make this file fail for an unrelated reason. A v1
 * vault is a supported shape: unlock() still has the v1 branch.
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
 *   npx vitest run tests/security/coadmin-workspace-key-allocation.test.ts
 *
 * It creates two ephemeral users and deletes them again in afterAll. It writes
 * one wrapped_data_keys row and one workspace_admins row, both removed with the
 * users. It never touches an existing account.
 */

import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { grantCoAdmin } from '@/lib/co-admin';
import { verifyMemberGrant } from '@/lib/member-grant';
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

// When env vars are absent the describe block below registers 0 tests, which is
// invisible in CI output. This explicit skip keeps the file in the vitest report
// so nobody reads "all green" as "the live-DB acceptance ran".
if (!RUN) {
  test.skip(
    'OR-T1114 workspace-key allocation tests SKIPPED: set ORANGERAILS_TEST_SUPABASE_URL, ' +
      'ORANGERAILS_TEST_SERVICE_ROLE_KEY, and ORANGERAILS_TEST_ANON_KEY to run against dev',
    () => {},
  );
}

/** Argon2id is deliberately slow; every test here pays for at least one run. */
const SLOW = 120_000;

describe.runIf(RUN)('OR-T1114: grantCoAdmin takes workspace_key_id from the server', () => {
  const admin = RUN
    ? createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
    : (null as never);

  const anonBase = RUN
    ? createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } })
    : (null as never);

  const fixture = {
    ownerId: '',
    targetId: '',
    noVaultId: '',
    ownerPassword: '',
    ownerSaltB64: '',
    ownerSigPubB64: '',
    targetKemPubB64: '',
    ownerClient: null as ReturnType<typeof createClient> | null,
    noVaultClient: null as ReturnType<typeof createClient> | null,
  };

  /**
   * Build one v1 vault row for a user, exactly as signup would except for the
   * key version, and return the material a caller needs to act as that user.
   *
   * The row is inserted by the service role because only the vault owner's own
   * browser would normally do this and there is no browser here. Nothing about
   * workspace_key_id is set: that is the point of the test.
   */
  async function seedV1Vault(userId: string, password: string) {
    const saltB64 = generateVaultSalt();

    // v1: the MEK IS the Argon2id output, which is what grantCoAdmin re-derives.
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

    // Same call signup makes, so the wrapped secrets are wrapped under the same
    // key grantCoAdmin will re-derive.
    const pqc = await buildPqcKeyMaterial(await derivePqcSecretWrapKey(mek, saltB64));
    const { error: pqcErr } = await admin
      .from('user_vault_meta')
      .update(pqc as unknown as Record<string, unknown>)
      .eq('user_id', userId);
    if (pqcErr) throw new Error(`Seed PQC material failed: ${pqcErr.message}`);

    return { saltB64, kemPublicKey: pqc.kem_public_key, sigPublicKey: pqc.sig_public_key };
  }

  async function signedInClient(email: string, password: string) {
    const { data, error } = await anonBase.auth.signInWithPassword({ email, password });
    if (error || !data.session) throw new Error(`Sign in ${email} failed: ${error?.message}`);
    return createClient(SUPABASE_URL!, ANON_KEY!, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
    });
  }

  beforeAll(async () => {
    const tag = String(Date.now());
    const accountPassword = `AcctT1114-${tag}`;
    fixture.ownerPassword = `VaultT1114-${tag}`;

    const emails = {
      owner: `t1114-owner-${tag}@orangerails-test.invalid`,
      target: `t1114-target-${tag}@orangerails-test.invalid`,
      noVault: `t1114-novault-${tag}@orangerails-test.invalid`,
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
      if (key === 'noVault') fixture.noVaultId = data.user.id;
    }

    const owner = await seedV1Vault(fixture.ownerId, fixture.ownerPassword);
    fixture.ownerSaltB64 = owner.saltB64;
    fixture.ownerSigPubB64 = owner.sigPublicKey;

    // The recipient needs a vault only for its KEM public key.
    const target = await seedV1Vault(fixture.targetId, `VaultT1114-target-${tag}`);
    fixture.targetKemPubB64 = target.kemPublicKey;

    fixture.ownerClient = await signedInClient(emails.owner, accountPassword);
    fixture.noVaultClient = await signedInClient(emails.noVault, accountPassword);
  }, SLOW);

  afterAll(async () => {
    // Deleting the auth users cascades the vault, wrapped-key and admin-list
    // rows, so nothing this test wrote outlives it.
    for (const id of [fixture.ownerId, fixture.targetId, fixture.noVaultId]) {
      if (id) await admin.auth.admin.deleteUser(id);
    }
  }, SLOW);

  test('the owner cannot write workspace_key_id directly', async () => {
    // The premise of the whole change. If this stops failing, the column
    // privilege has come back and a caller can choose its own workspace key id
    // again, which is what let a caller claim another tenant's data_key_id.
    const { error } = await fixture
      .ownerClient!.from('user_vault_meta')
      .update({ workspace_key_id: crypto.randomUUID() })
      .eq('user_id', fixture.ownerId);

    expect(error).not.toBeNull();
    expect(String((error as { code?: string } | null)?.code ?? '')).toBe('42501');
  });

  test(
    'grantCoAdmin allocates server-side and signs the id the server stored',
    async () => {
      const { workspaceKeyId } = await grantCoAdmin({
        ownerUserId: fixture.ownerId,
        ownerSaltB64: fixture.ownerSaltB64,
        ownerPassword: fixture.ownerPassword,
        ownerSigSecretWrapped: await sigSecretWrappedFor(fixture.ownerId),
        targetUserId: fixture.targetId,
        targetKemPubB64: fixture.targetKemPubB64,
        // null is the case under test: nothing allocated yet, so the RPC runs.
        existingKeyId: null,
        supabase: fixture.ownerClient as unknown as Parameters<typeof grantCoAdmin>[0]['supabase'],
      });

      expect(typeof workspaceKeyId).toBe('string');
      expect(workspaceKeyId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );

      // (2) the id it returned is the id the SERVER stored, not one it minted.
      const { data: metaRow, error: metaErr } = await admin
        .from('user_vault_meta')
        .select('workspace_key_id')
        .eq('user_id', fixture.ownerId)
        .single();
      expect(metaErr).toBeNull();
      expect((metaRow as { workspace_key_id: string }).workspace_key_id).toBe(workspaceKeyId);

      // (3) the wrapped key row is bound to that same id.
      const { data: wdkRows, error: wdkErr } = await admin
        .from('wrapped_data_keys')
        .select('data_key_id, recipient_user_id, wrapped_ciphertext, grant_sig')
        .eq('recipient_user_id', fixture.targetId);
      expect(wdkErr).toBeNull();
      expect(wdkRows).toHaveLength(1);

      const row = wdkRows![0] as {
        data_key_id: string;
        wrapped_ciphertext: string;
        grant_sig: string | null;
      };
      expect(row.data_key_id).toBe(workspaceKeyId);

      // (4) the ordering assertion: the signature covers the ALLOCATED id, so
      // the allocation must have happened before the signature was computed.
      expect(row.grant_sig).toBeTruthy();
      await expect(
        verifyMemberGrant(
          fixture.ownerSigPubB64,
          {
            memberUserId: fixture.targetId,
            workspaceKeyId,
            wrappedMekCiphertextB64: row.wrapped_ciphertext,
          },
          row.grant_sig!,
        ),
      ).resolves.toBe(true);

      // And the negative: the same signature must NOT verify against some other
      // id, which is what a locally minted uuid would have produced.
      await expect(
        verifyMemberGrant(
          fixture.ownerSigPubB64,
          {
            memberUserId: fixture.targetId,
            workspaceKeyId: crypto.randomUUID(),
            wrappedMekCiphertextB64: row.wrapped_ciphertext,
          },
          row.grant_sig!,
        ),
      ).resolves.toBe(false);
    },
    SLOW,
  );

  test(
    'a caller with no vault row is refused before anything is signed',
    async () => {
      // allocate_workspace_key raises when the caller has no user_vault_meta
      // row. The grant must stop there. The salt and password below belong to
      // the owner and are only there to get as far as the RPC.
      await expect(
        grantCoAdmin({
          ownerUserId: fixture.noVaultId,
          ownerSaltB64: fixture.ownerSaltB64,
          ownerPassword: fixture.ownerPassword,
          ownerSigSecretWrapped: await sigSecretWrappedFor(fixture.ownerId),
          targetUserId: fixture.targetId,
          targetKemPubB64: fixture.targetKemPubB64,
          existingKeyId: null,
          supabase: fixture.noVaultClient as unknown as Parameters<
            typeof grantCoAdmin
          >[0]['supabase'],
        }),
      ).rejects.toThrow(/allocate workspace_key_id/i);

      // Nothing was written for this user: no half-finished grant.
      const { data: rows } = await admin
        .from('wrapped_data_keys')
        .select('data_key_id')
        .eq('recipient_user_id', fixture.noVaultId);
      expect(rows ?? []).toHaveLength(0);
    },
    SLOW,
  );

  /** Read a user's wrapped ML-DSA-65 secret back out, as VaultContext does. */
  async function sigSecretWrappedFor(userId: string): Promise<string> {
    const { data, error } = await admin
      .from('user_vault_meta')
      .select('sig_secret_wrapped')
      .eq('user_id', userId)
      .single();
    if (error) throw new Error(`Read sig_secret_wrapped failed: ${error.message}`);
    const wrapped = (data as { sig_secret_wrapped: string | null }).sig_secret_wrapped;
    if (!wrapped) throw new Error('Fixture has no sig_secret_wrapped');
    return wrapped;
  }
});
