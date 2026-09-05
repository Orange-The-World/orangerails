/**
 * OR-21: audit_entries cross-tenant RLS isolation.
 *
 * The "Users read own audit entries" policy on audit_entries must prevent
 * any authenticated user from reading another user's rows. This was left
 * with zero test coverage after the agent-membership feature retirement
 * removed the only fixture that seeded the table.
 *
 * This is a live-database test. It requires three environment variables:
 *   ORANGERAILS_TEST_SUPABASE_URL         - dev Supabase project URL
 *   ORANGERAILS_TEST_SERVICE_ROLE_KEY     - service-role key (admin + RPC seeding)
 *   ORANGERAILS_TEST_ANON_KEY             - anon/public key (user sign-in)
 *
 * Run manually against dev (never in CI; no Supabase credentials live in CI):
 *   ORANGERAILS_TEST_SUPABASE_URL=... \
 *   ORANGERAILS_TEST_SERVICE_ROLE_KEY=... \
 *   ORANGERAILS_TEST_ANON_KEY=... \
 *   bunx vitest run tests/security/rls.test.ts
 *
 * Fixture design: two ephemeral users (A and B) are created via auth.admin,
 * one audit_entries row is seeded for each via append_audit_entry (a
 * SECURITY DEFINER function executable only by service_role). Each user
 * then queries audit_entries with their own JWT. No shared fixtures and no
 * dependency on the retired agent-membership fixture.
 */

import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const SUPABASE_URL = process.env.ORANGERAILS_TEST_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.ORANGERAILS_TEST_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.ORANGERAILS_TEST_ANON_KEY;

const RUN = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY);

// When env vars are absent the describe block below registers 0 tests, which
// is invisible in CI output. This explicit skip ensures the file always
// appears in the vitest report so reviewers know the live-DB tests were not
// silently dropped.
if (!RUN) {
  test.skip(
    'OR-21 RLS isolation tests SKIPPED: set ORANGERAILS_TEST_SUPABASE_URL, ' +
      'ORANGERAILS_TEST_SERVICE_ROLE_KEY, and ORANGERAILS_TEST_ANON_KEY to run against dev',
    () => {},
  );
}

describe.runIf(RUN)('OR-21: audit_entries cross-tenant RLS isolation', () => {
  // Service-role client: used for fixture setup, teardown, and RLS bypass baseline.
  const admin = RUN
    ? createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
    : (null as never);

  // Anon client: used only for user sign-in (signInWithPassword).
  const anonBase = RUN
    ? createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } })
    : (null as never);

  // Fixture state, populated in beforeAll.
  const fixture = {
    userAId: '',
    userBId: '',
    entryIdA: '',
    entryIdB: '',
    clientA: null as ReturnType<typeof createClient> | null,
    clientB: null as ReturnType<typeof createClient> | null,
  };

  beforeAll(async () => {
    const tag = String(Date.now());
    const emailA = `or21-a-${tag}@orangerails-test.invalid`;
    const emailB = `or21-b-${tag}@orangerails-test.invalid`;
    const password = `RLStest-${tag}`;

    // Create two ephemeral users, email_confirm: true bypasses the
    // confirmation email so signInWithPassword works immediately.
    const { data: dA, error: eA } = await admin.auth.admin.createUser({
      email: emailA,
      password,
      email_confirm: true,
    });
    if (eA || !dA.user) throw new Error(`Create user A failed: ${eA?.message}`);
    fixture.userAId = dA.user.id;

    const { data: dB, error: eB } = await admin.auth.admin.createUser({
      email: emailB,
      password,
      email_confirm: true,
    });
    if (eB || !dB.user) throw new Error(`Create user B failed: ${eB?.message}`);
    fixture.userBId = dB.user.id;

    // Seed one audit entry per user via the service-role-only RPC.
    // append_audit_entry is SECURITY DEFINER and executable only by service_role,
    // so only this client can call it. Returns TABLE(entry_id, chain_height, this_hash).
    const { data: rowA, error: errA } = await admin.rpc('append_audit_entry', {
      p_action: 'test.or21_rls_isolation',
      p_actor_user_id: fixture.userAId,
      p_resource_type: 'test',
      p_resource_id: `or21-a-${tag}`,
      p_result: 'ok',
    });
    if (errA || !rowA?.[0]) throw new Error(`Seed entry A failed: ${errA?.message}`);
    fixture.entryIdA = rowA[0].entry_id;

    const { data: rowB, error: errB } = await admin.rpc('append_audit_entry', {
      p_action: 'test.or21_rls_isolation',
      p_actor_user_id: fixture.userBId,
      p_resource_type: 'test',
      p_resource_id: `or21-b-${tag}`,
      p_result: 'ok',
    });
    if (errB || !rowB?.[0]) throw new Error(`Seed entry B failed: ${errB?.message}`);
    fixture.entryIdB = rowB[0].entry_id;

    // Sign in as each user to obtain their JWT, then build authenticated
    // clients that send the JWT as a Bearer token. This is the correct way
    // to exercise RLS as a specific user without a full browser session.
    const { data: sessA, error: errSessA } = await anonBase.auth.signInWithPassword({
      email: emailA,
      password,
    });
    if (errSessA || !sessA.session)
      throw new Error(`Sign in user A failed: ${errSessA?.message}`);

    const { data: sessB, error: errSessB } = await anonBase.auth.signInWithPassword({
      email: emailB,
      password,
    });
    if (errSessB || !sessB.session)
      throw new Error(`Sign in user B failed: ${errSessB?.message}`);

    fixture.clientA = createClient(SUPABASE_URL!, ANON_KEY!, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${sessA.session.access_token}` } },
    });
    fixture.clientB = createClient(SUPABASE_URL!, ANON_KEY!, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${sessB.session.access_token}` } },
    });
  }, 30_000);

  afterAll(async () => {
    // Delete the ephemeral users. audit_entries rows are immutable by design
    // (no DELETE policy) and will remain in the chain, which is acceptable.
    if (fixture.userAId) await admin.auth.admin.deleteUser(fixture.userAId);
    if (fixture.userBId) await admin.auth.admin.deleteUser(fixture.userBId);
  });

  test('user A reads their own audit entry', async () => {
    const { data, error } = await fixture.clientA!
      .from('audit_entries')
      .select('id')
      .eq('id', fixture.entryIdA);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].id).toBe(fixture.entryIdA);
  });

  test('user A cannot read user B audit entry (cross-tenant isolation)', async () => {
    // RLS returns an empty result set, not an error, for rows the user cannot see.
    const { data, error } = await fixture.clientA!
      .from('audit_entries')
      .select('id')
      .eq('id', fixture.entryIdB);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  test('user B reads their own audit entry', async () => {
    const { data, error } = await fixture.clientB!
      .from('audit_entries')
      .select('id')
      .eq('id', fixture.entryIdB);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].id).toBe(fixture.entryIdB);
  });

  test('user B cannot read user A audit entry (cross-tenant isolation)', async () => {
    const { data, error } = await fixture.clientB!
      .from('audit_entries')
      .select('id')
      .eq('id', fixture.entryIdA);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  test('service_role bypasses RLS and sees both entries (baseline)', async () => {
    // Confirms the rows exist and isolation is enforced by RLS, not missing data.
    const { data, error } = await admin
      .from('audit_entries')
      .select('id')
      .in('id', [fixture.entryIdA, fixture.entryIdB]);
    expect(error).toBeNull();
    expect(data).toHaveLength(2);
  });
});
