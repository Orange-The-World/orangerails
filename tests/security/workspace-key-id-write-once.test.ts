/**
 * OR-T0805: user_vault_meta.workspace_key_id is unique and write-once,
 * and an authenticated non-owner cannot claim another tenant's value.
 *
 * WHAT THIS PROVES, AND WHY A UNIT TEST CANNOT.
 * Every wrapped_data_keys policy decides who the owner is by looking up
 * public.user_vault_meta.workspace_key_id. A revoked co-admin still knows
 * that value: it is the data_key_id on the wrapped row they used to hold.
 * Writing it into their own user_vault_meta row makes them satisfy the
 * owner clause. Unique and write-once are the database controls that stop
 * that. A mocked Supabase client has no constraints and no triggers, so a
 * unit test built on one passes identically with or without the guards and
 * proves nothing. The only way to exercise them is a real authenticated
 * session against a real database.
 *
 * THE THREE ASSERTIONS.
 *   1. As an authenticated non-owner, UPDATE own row SET workspace_key_id
 *      = the owner's id is refused. This is the attack the ticket names.
 *      The SQLSTATE may be 42501 (column privilege later revoked) or 23505
 *      (unique constraint) or P0001 (write-once). Any of those is a
 *      refusal. A successful write, or a 0-row update with no error, is
 *      a failure of the control.
 *   2. As the service role, which can still write the column, changing a
 *      set workspace_key_id is refused by the write-once trigger.
 *   3. As the service role, a second row claiming an in-use id is refused
 *      by the unique constraint (23505). Write-once does not fire here
 *      because the attacker's column is still NULL.
 *
 * Plus the positive: the first NULL -> value write is allowed. If that
 * one ever goes red, the trigger is refusing the allocation the grant
 * path needs, and the negatives above would be unearned.
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
 *   npx vitest run tests/security/workspace-key-id-write-once.test.ts
 *
 * It creates two ephemeral users and deletes them again in afterAll. It
 * never touches an existing account. Do not point it at production.
 */

import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const SUPABASE_URL = process.env.ORANGERAILS_TEST_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.ORANGERAILS_TEST_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.ORANGERAILS_TEST_ANON_KEY;

const RUN = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);

// When env vars are absent the describe block below registers 0 tests, which is
// invisible in CI output. This explicit skip keeps the file in the vitest report
// so nobody reads "all green" as "the live-DB acceptance ran".
if (!RUN) {
  test.skip(
    'OR-T0805 workspace-key unique/write-once tests SKIPPED: set ORANGERAILS_TEST_SUPABASE_URL, ' +
      'ORANGERAILS_TEST_SERVICE_ROLE_KEY, and ORANGERAILS_TEST_ANON_KEY to run against dev',
    () => {},
  );
}

const SLOW = 60_000;

describe.runIf(RUN)('OR-T0805: workspace_key_id is unique and write-once', () => {
  const admin = RUN
    ? createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
    : (null as never);

  const anonBase = RUN
    ? createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } })
    : (null as never);

  const fixture = {
    ownerId: '',
    attackerId: '',
    stolenKeyId: '',
    attackerClient: null as ReturnType<typeof createClient> | null,
  };

  async function seedVaultRow(userId: string) {
    const { error } = await admin.from('user_vault_meta').insert({
      user_id: userId,
      vault_salt: `or-t0805-${userId}`,
      vault_verifier_ciphertext: `or-t0805-${userId}`,
    });
    if (error) throw new Error(`Seed vault row failed: ${error.message}`);
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
    const accountPassword = `AcctT0805-${tag}`;
    const emails = {
      owner: `t0805-owner-${tag}@orangerails-test.invalid`,
      attacker: `t0805-attacker-${tag}@orangerails-test.invalid`,
    };

    for (const [key, email] of Object.entries(emails)) {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password: accountPassword,
        email_confirm: true,
      });
      if (error || !data.user) throw new Error(`Create ${key} failed: ${error?.message}`);
      if (key === 'owner') fixture.ownerId = data.user.id;
      if (key === 'attacker') fixture.attackerId = data.user.id;
    }

    await seedVaultRow(fixture.ownerId);
    await seedVaultRow(fixture.attackerId);

    fixture.stolenKeyId = crypto.randomUUID();
    const { error: firstSetErr } = await admin
      .from('user_vault_meta')
      .update({ workspace_key_id: fixture.stolenKeyId })
      .eq('user_id', fixture.ownerId);
    if (firstSetErr) {
      throw new Error(
        `First set of workspace_key_id was refused: ${firstSetErr.message}. ` +
          'The write-once guard must allow NULL -> value; a refusal here makes every later case unearned.',
      );
    }

    fixture.attackerClient = await signedInClient(emails.attacker, accountPassword);
  }, SLOW);

  afterAll(async () => {
    for (const id of [fixture.ownerId, fixture.attackerId]) {
      if (id) await admin.auth.admin.deleteUser(id);
    }
  }, SLOW);

  test('first set of workspace_key_id is stored on the owner row', async () => {
    const { data, error } = await admin
      .from('user_vault_meta')
      .select('workspace_key_id')
      .eq('user_id', fixture.ownerId)
      .single();
    expect(error).toBeNull();
    expect((data as { workspace_key_id: string }).workspace_key_id).toBe(fixture.stolenKeyId);
  });

  test('authenticated non-owner cannot claim the owner workspace_key_id', async () => {
    // THE ATTACK THE TICKET NAMES. A revoked co-admin writes the data_key_id
    // they already know into their own vault row. If this UPDATE lands, they
    // satisfy the owner clause of every wrapped_data_keys policy.
    const { data, error } = await fixture
      .attackerClient!.from('user_vault_meta')
      .update({ workspace_key_id: fixture.stolenKeyId })
      .eq('user_id', fixture.attackerId)
      .select('workspace_key_id');

    expect(error).not.toBeNull();
    expect(data ?? []).toHaveLength(0);

    const code = String((error as { code?: string } | null)?.code ?? '');
    // 42501 = column privilege revoked (later hardening).
    // 23505 = unique constraint (the load-bearing half of this ticket).
    // P0001 = write-once trigger (only if the attacker row was already set).
    expect(['42501', '23505', 'P0001']).toContain(code);

    const { data: after, error: afterErr } = await admin
      .from('user_vault_meta')
      .select('workspace_key_id')
      .eq('user_id', fixture.attackerId)
      .single();
    expect(afterErr).toBeNull();
    expect((after as { workspace_key_id: string | null }).workspace_key_id).toBeNull();
  });

  test('a set workspace_key_id cannot be repointed, even by the service role', async () => {
    const { error } = await admin
      .from('user_vault_meta')
      .update({ workspace_key_id: crypto.randomUUID() })
      .eq('user_id', fixture.ownerId);

    expect(error).not.toBeNull();
    expect(String((error as { message?: string } | null)?.message ?? '')).toMatch(/write-once/i);

    const { data, error: readErr } = await admin
      .from('user_vault_meta')
      .select('workspace_key_id')
      .eq('user_id', fixture.ownerId)
      .single();
    expect(readErr).toBeNull();
    expect((data as { workspace_key_id: string }).workspace_key_id).toBe(fixture.stolenKeyId);
  });

  test('a second row cannot claim an in-use workspace_key_id', async () => {
    // Attacker row is still NULL, so write-once does not fire. Unique is the
    // only control that can stop this write for a role that holds the privilege.
    const { error } = await admin
      .from('user_vault_meta')
      .update({ workspace_key_id: fixture.stolenKeyId })
      .eq('user_id', fixture.attackerId);

    expect(error).not.toBeNull();
    expect(String((error as { code?: string } | null)?.code ?? '')).toBe('23505');
  });
});
