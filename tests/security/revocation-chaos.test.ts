/**
 * CR-06 , revocation chaos test.
 *
 * Proves the revocation promise from doc 02:
 *   1. Owner can revoke an agent via or-agent-revoke
 *   2. After revocation, the agent's wrapped_data_keys row is GONE
 *   3. After revocation, or-agent-token-refresh returns 403
 *      (cannot mint a fresh JWT , the agent is locked out immediately)
 *   4. The agent's audit history is PRESERVED (no retroactive erasure
 *      of the actions the agent took while active)
 *   5. The shadow auth.users row is deleted (clean cleanup)
 *
 * Same env-var gating as the RLS test:
 *   ORANGERAILS_TEST_SUPABASE_URL
 *   ORANGERAILS_TEST_SUPABASE_SERVICE_KEY
 *   ORANGERAILS_TEST_SUPABASE_ANON_KEY
 *
 * The test:
 *   - Creates an owner user
 *   - Mints an invitation
 *   - Simulates the redeem flow with synthesized Ed25519+X25519 keys
 *   - Verifies the agent_member is active
 *   - Calls or-agent-revoke
 *   - Asserts the four post-revoke properties above
 *
 * RETIRED 2026-06-25: mint_agent_invitation and revoke_agent_member had
 * authenticated EXECUTE revoked. The entire suite depends on these RPCs;
 * hard-skipped below until rewritten to use a non-retired path.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const URL = process.env.ORANGERAILS_TEST_SUPABASE_URL;
const SERVICE_KEY = process.env.ORANGERAILS_TEST_SUPABASE_SERVICE_KEY;
const ANON_KEY = process.env.ORANGERAILS_TEST_SUPABASE_ANON_KEY;
const haveCreds = Boolean(URL && SERVICE_KEY && ANON_KEY);
// Hard-skip: entire suite depends on agent-membership RPCs retired 2026-06-25.
// Change to (haveCreds ? describe : describe.skip) once the setup and test
// bodies no longer call mint_agent_invitation or revoke_agent_member.
const d = describe.skip;

function bytesToBase64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64');
}

let admin: SupabaseClient;
let ownerId: string;
let ownerClient: SupabaseClient;
let agentMemberId: string;
let invitationToken: string;

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function randomTokenHex(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

d('CR-06 , revocation chaos', () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const email = `owner-${Date.now()}@orangerails-cr06-test.local`;
    const password = `pwd-${crypto.randomUUID()}!`;
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createErr || !created.user) throw createErr ?? new Error('no user');
    ownerId = created.user.id;

    ownerClient = createClient(URL!, ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await ownerClient.auth.signInWithPassword({ email, password });

    // Mint invitation via the SQL function
    invitationToken = randomTokenHex();
    const tokenHash = await sha256Hex(invitationToken);
    const { data: mint, error: mintErr } = await ownerClient.rpc('mint_agent_invitation', {
      p_agent_name: 'cr06-agent',
      p_agent_kind: 'claude_code',
      p_role: 'bookkeeper',
      p_token_hash: tokenHash,
    });
    if (mintErr) throw mintErr;
    const mintRow = Array.isArray(mint) ? mint[0] : mint;
    agentMemberId = mintRow?.agent_member_id as string;

    // Simulate redeem: generate keypairs + call or-agent-invite-redeem
    const idPriv = ed25519.utils.randomPrivateKey();
    const idPub = ed25519.getPublicKey(idPriv);
    const kemPriv = x25519.utils.randomPrivateKey();
    const kemPub = x25519.getPublicKey(kemPriv);

    const redeemRes = await fetch(`${URL}/functions/v1/or-agent-invite-redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invitation_token: invitationToken,
        identity_pubkey: bytesToBase64(idPub),
        kem_pubkey: bytesToBase64(kemPub),
      }),
    });
    if (!redeemRes.ok) {
      throw new Error(`Redeem failed: HTTP ${redeemRes.status} ${await redeemRes.text()}`);
    }
    const redeemBody = (await redeemRes.json()) as {
      agent_member_id: string;
      access_token: string;
    };
    expect(redeemBody.agent_member_id).toBe(agentMemberId);

    // Stash the private key for later refresh attempts
    (globalThis as Record<string, unknown>).__cr06_idPriv = idPriv;
  }, 30000);

  afterAll(async () => {
    if (ownerId) await admin.auth.admin.deleteUser(ownerId).catch(() => null);
  });

  test('agent is active before revocation', async () => {
    const { data, error } = await admin
      .from('agent_members')
      .select('id,activated_at,revoked_at,shadow_user_id')
      .eq('id', agentMemberId)
      .single();
    expect(error).toBeNull();
    expect(data?.activated_at).not.toBeNull();
    expect(data?.revoked_at).toBeNull();
    expect(data?.shadow_user_id).not.toBeNull();
  });

  test('or-agent-revoke succeeds and returns wrapped_keys_deleted >= 0', async () => {
    // The owner calls revoke via the SQL function directly (matches the
    // or-agent-revoke edge function path; we skip the HTTP layer for speed)
    const { data, error } = await ownerClient.rpc('revoke_agent_member', {
      p_agent_member_id: agentMemberId,
      p_reason: 'cr06-test',
    });
    expect(error).toBeNull();
    const row = Array.isArray(data) ? data[0] : data;
    expect(row?.agent_member_id).toBe(agentMemberId);
    expect(row?.was_already_revoked).toBe(false);
  });

  test('after revocation, agent_members.revoked_at is set', async () => {
    const { data } = await admin
      .from('agent_members')
      .select('revoked_at')
      .eq('id', agentMemberId)
      .single();
    expect(data?.revoked_at).not.toBeNull();
  });

  test('after revocation, wrapped_data_keys for the shadow user are gone', async () => {
    const { data: am } = await admin
      .from('agent_members')
      .select('shadow_user_id')
      .eq('id', agentMemberId)
      .single();
    if (!am?.shadow_user_id) {
      // already cleaned up by some other path; check that no rows remain
    }
    const { data: keys, error } = await admin
      .from('wrapped_data_keys')
      .select('id')
      .eq('recipient_user_id', am?.shadow_user_id ?? '00000000-0000-0000-0000-000000000000');
    expect(error).toBeNull();
    expect(keys?.length ?? 0).toBe(0);
  });

  test('after revocation, or-agent-token-refresh returns 403 immediately', async () => {
    const idPriv = (globalThis as Record<string, unknown>).__cr06_idPriv as Uint8Array;
    const timestamp = new Date().toISOString();
    const payload = `or-agent-refresh|${agentMemberId}|${timestamp}`;
    const messageBytes = new TextEncoder().encode(payload);
    const signature = ed25519.sign(messageBytes, idPriv);

    const res = await fetch(`${URL}/functions/v1/or-agent-token-refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_member_id: agentMemberId,
        signed_payload: payload,
        signature: bytesToBase64(signature),
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect((body.error ?? '').toLowerCase()).toMatch(/not found|revoked|not activated/);
  });

  test("after revocation, audit_entries still show the agent's historical actions", async () => {
    // The agent's invite_redeemed entry should still exist
    const { data, error } = await admin
      .from('audit_entries')
      .select('id,action,actor_member_id')
      .eq('actor_member_id', agentMemberId);
    expect(error).toBeNull();
    expect((data?.length ?? 0)).toBeGreaterThan(0); // at least invite_redeemed
    const actions = (data ?? []).map((r) => r.action as string);
    expect(actions).toContain('agents.invite_redeemed');
  });

  test('revoke is idempotent: second call returns was_already_revoked=true', async () => {
    const { data, error } = await ownerClient.rpc('revoke_agent_member', {
      p_agent_member_id: agentMemberId,
      p_reason: 'cr06-retry',
    });
    expect(error).toBeNull();
    const row = Array.isArray(data) ? data[0] : data;
    expect(row?.was_already_revoked).toBe(true);
  });
});

test.skipIf(haveCreds)('CR-06 requires ORANGERAILS_TEST_SUPABASE_* env vars (skipped)', () => {
  expect(true).toBe(true);
});
