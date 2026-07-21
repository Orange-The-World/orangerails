/**
 * RLS policy tests , cross-tenant access denial assertions.
 *
 * These tests create two real Supabase users (alice + bob), each with
 * their own agent_members rows, and verify that:
 *   1. Alice can SELECT her own agent_members; Bob's SELECT returns nothing
 *      (RLS hides the row, not 403)
 *   2. Alice can SELECT her own agent_invitation_tokens; Bob cannot see them
 *   3. Alice can read her own audit_entries; Bob cannot
 *   4. wrapped_data_keys: recipient can read their own row only
 *   5. INSERT/UPDATE/DELETE attempts via the user-scoped client are blocked
 *      (writes only via SECURITY DEFINER functions)
 *
 * Environment variables required:
 *   ORANGERAILS_TEST_SUPABASE_URL
 *   ORANGERAILS_TEST_SUPABASE_SERVICE_KEY
 *   ORANGERAILS_TEST_SUPABASE_ANON_KEY
 *
 * When not set, the test suite is skipped (so CI without RLS-test
 * credentials still passes). To run locally:
 *   ORANGERAILS_TEST_SUPABASE_URL=... \
 *   ORANGERAILS_TEST_SUPABASE_SERVICE_KEY=... \
 *   ORANGERAILS_TEST_SUPABASE_ANON_KEY=... \
 *     bunx vitest run tests/security/rls.test.ts
 *
 * The test creates throwaway users and cleans up in afterAll.
 *
 * RETIRED 2026-06-25: mint_agent_invitation, revoke_agent_invitation_token,
 * and revoke_agent_member had authenticated EXECUTE revoked. This suite's
 * beforeAll calls mint_agent_invitation to seed data; if secrets are added
 * to CI the entire block would error. Hard-skipped below until the suite
 * is rewritten to use a setup path that does not require the retired RPCs.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const URL = process.env.ORANGERAILS_TEST_SUPABASE_URL;
const SERVICE_KEY = process.env.ORANGERAILS_TEST_SUPABASE_SERVICE_KEY;
const ANON_KEY = process.env.ORANGERAILS_TEST_SUPABASE_ANON_KEY;
const haveCreds = Boolean(URL && SERVICE_KEY && ANON_KEY);
// Hard-skip: suite depends on agent-membership RPCs retired 2026-06-25.
// Change to (haveCreds ? describe : describe.skip) once the setup path
// no longer calls mint_agent_invitation.
const d = describe.skip;

interface TestUser {
  id: string;
  email: string;
  client: SupabaseClient;
}

let admin: SupabaseClient;
let alice: TestUser;
let bob: TestUser;
let aliceAgentMemberId: string | null = null;

async function makeUser(email: string): Promise<TestUser> {
  const password = `test-pwd-${crypto.randomUUID()}!`;
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !created.user) throw error ?? new Error('no user');
  const userClient = createClient(URL!, ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInErr } = await userClient.auth.signInWithPassword({ email, password });
  if (signInErr) throw signInErr;
  return { id: created.user.id, email, client: userClient };
}

async function deleteUserSafe(id: string) {
  try {
    await admin.auth.admin.deleteUser(id);
  } catch (e) {
    console.warn('[rls.test] cleanup failed for', id, e);
  }
}

d('RLS policies , cross-tenant access denial', () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    alice = await makeUser(`alice-${Date.now()}@orangerails-rls-test.local`);
    bob = await makeUser(`bob-${Date.now()}@orangerails-rls-test.local`);

    // Alice mints a fake agent invitation via the SQL function (her auth context)
    const sha256 = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode('alice-test-token-' + crypto.randomUUID()),
    );
    const tokenHash = Array.from(new Uint8Array(sha256))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const { data: mint, error: mintErr } = await alice.client.rpc('mint_agent_invitation', {
      p_agent_name: 'alice-test-agent',
      p_agent_kind: 'claude_code',
      p_role: 'bookkeeper',
      p_token_hash: tokenHash,
    });
    if (mintErr) throw mintErr;
    const row = Array.isArray(mint) ? mint[0] : mint;
    aliceAgentMemberId = row?.agent_member_id as string;
  }, 30000);

  afterAll(async () => {
    if (alice) await deleteUserSafe(alice.id);
    if (bob) await deleteUserSafe(bob.id);
  });

  test('Alice can SELECT her own agent_members; Bob cannot see Alice rows', async () => {
    const { data: aliceRows, error: aliceErr } = await alice.client
      .from('agent_members')
      .select('id,agent_name')
      .eq('owner_user_id', alice.id);
    expect(aliceErr).toBeNull();
    expect(aliceRows?.length).toBeGreaterThanOrEqual(1);

    const { data: bobRows, error: bobErr } = await bob.client
      .from('agent_members')
      .select('id,agent_name')
      .eq('owner_user_id', alice.id);
    expect(bobErr).toBeNull();
    // RLS hides Alice's rows , Bob gets empty
    expect(bobRows?.length).toBe(0);
  });

  test('Alice can SELECT her own agent_invitation_tokens; Bob cannot see them', async () => {
    const { data: aliceRows, error: aliceErr } = await alice.client
      .from('agent_invitation_tokens')
      .select('id,owner_user_id')
      .eq('owner_user_id', alice.id);
    expect(aliceErr).toBeNull();
    expect(aliceRows?.length).toBeGreaterThanOrEqual(1);

    const { data: bobRows, error: bobErr } = await bob.client
      .from('agent_invitation_tokens')
      .select('id,owner_user_id')
      .eq('owner_user_id', alice.id);
    expect(bobErr).toBeNull();
    expect(bobRows?.length).toBe(0);
  });

  test('Bob cannot INSERT an agent_members row claiming Alice as the owner', async () => {
    // Direct INSERT should be blocked: no INSERT policy on agent_members
    // (writes go through SECURITY DEFINER functions only).
    const { error } = await bob.client
      .from('agent_members')
      .insert({
        owner_user_id: alice.id,
        agent_name: 'malicious-injection',
        agent_kind: 'custom',
        role: 'owner',
      });
    expect(error).not.toBeNull(); // RLS rejects
  });

  test("Bob cannot UPDATE Alice's agent_members row", async () => {
    if (!aliceAgentMemberId) throw new Error('test setup did not create an agent_member');
    const { error, data } = await bob.client
      .from('agent_members')
      .update({ agent_name: 'tampered' })
      .eq('id', aliceAgentMemberId)
      .select();
    // Either the update is silently filtered out (data empty) or RLS errors.
    if (!error) {
      expect(data?.length ?? 0).toBe(0);
    }
  });

  test("Alice can call revoke_agent_invitation_token on her own; Bob cannot on Alice's", async () => {
    if (!aliceAgentMemberId) throw new Error('test setup did not create an agent_member');

    // Look up Alice's invitation row id via her client
    const { data: tokens } = await alice.client
      .from('agent_invitation_tokens')
      .select('id')
      .eq('agent_member_id', aliceAgentMemberId)
      .limit(1);
    expect(tokens?.[0]?.id).toBeDefined();
    const tokenId = tokens![0].id as string;

    // Bob tries to revoke , function rejects with Forbidden
    const { error: bobErr } = await bob.client.rpc('revoke_agent_invitation_token', {
      p_token_id: tokenId,
    });
    expect(bobErr).not.toBeNull();
    expect((bobErr?.message ?? '')).toMatch(/forbidden|not the owner/i);

    // Alice can revoke
    const { error: aliceErr } = await alice.client.rpc('revoke_agent_invitation_token', {
      p_token_id: tokenId,
    });
    expect(aliceErr).toBeNull();
  });

  test("Bob cannot call revoke_agent_member on Alice's agent", async () => {
    if (!aliceAgentMemberId) throw new Error('test setup did not create an agent_member');
    const { error } = await bob.client.rpc('revoke_agent_member', {
      p_agent_member_id: aliceAgentMemberId,
      p_reason: 'malicious test',
    });
    expect(error).not.toBeNull();
    expect((error?.message ?? '')).toMatch(/forbidden|not the owner/i);
  });

  test('audit_entries: actor reads own entries; non-actor cannot', async () => {
    // Alice's mint produced an audit row attributed to her
    const { data: aliceAudit, error: aliceErr } = await alice.client
      .from('audit_entries')
      .select('id,action,actor_user_id')
      .eq('actor_user_id', alice.id);
    expect(aliceErr).toBeNull();
    // At least the agents.invite_minted entry should be visible to Alice
    expect((aliceAudit?.length ?? 0)).toBeGreaterThanOrEqual(1);

    const { data: bobView, error: bobErr } = await bob.client
      .from('audit_entries')
      .select('id,action')
      .eq('actor_user_id', alice.id);
    expect(bobErr).toBeNull();
    expect(bobView?.length).toBe(0);
  });
});

// Always-on: even without creds, document that the test exists.
test.skipIf(haveCreds)('RLS tests require ORANGERAILS_TEST_SUPABASE_* env vars (skipped)', () => {
  expect(true).toBe(true);
});
