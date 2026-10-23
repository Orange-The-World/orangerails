/**
 * OR-T0421 step 3: or-mcp must verify the bearer token before any method.
 *
 * Run with:
 *   deno test --no-check --allow-read supabase/functions/or-mcp/auth.test.ts
 *
 * Two kinds of test.
 *
 * Behaviour: authenticateRequest with a stubbed GoTrue. A token that is well
 * formed in every way except its signature (right shape, shadow-agent claims,
 * expiry far in the future) is refused 401 for initialize, ping and tools/list,
 * and GoTrue is asked exactly once per request. A positive control proves the
 * same helper accepts a token GoTrue accepts, so the refusals are not a helper
 * that always says no.
 *
 * Structure: index.ts is not importable because it calls Deno.serve at import
 * time. The order is therefore pinned by reading its source: the token check
 * must come before the body is read and before the method switch.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { authenticateRequest } from './auth.ts';

const SUPABASE_URL = 'https://example.supabase.co';

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Only a signature check can refuse this token: the shape, the claims and the
// expiry are all fine.
const FORGED = [
  b64url({ alg: 'HS256', typ: 'JWT' }),
  b64url({
    sub: '00000000-0000-4000-8000-000000000001',
    exp: 4102444800,
    user_metadata: {
      is_shadow_agent: true,
      agent_member_id: 'member-1',
      owner_user_id: 'owner-1',
      agent_role: 'bookkeeper'
    }
  }),
  'not-the-real-signature'
].join('.');

function stubGoTrue(status: number) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetchImpl = (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    calls.push({ url, authorization: headers.get('Authorization') });
    return Promise.resolve(new Response(JSON.stringify({ msg: 'stub' }), { status }));
  };
  return { fetchImpl, calls };
}

function rpcRequest(method: string, token: string | null): Request {
  return new Request(`${SUPABASE_URL}/functions/v1/or-mcp`, {
    method: 'POST',
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method })
  });
}

for (const method of ['initialize', 'ping', 'tools/list']) {
  Deno.test(`a well-formed token with a bad signature gets 401 on ${method}`, async () => {
    const gotrue = stubGoTrue(401);
    const result = await authenticateRequest(rpcRequest(method, FORGED), {
      supabaseUrl: SUPABASE_URL,
      anonKey: 'anon-key',
      fetchImpl: gotrue.fetchImpl
    });
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.status, 401);
    assertEquals(gotrue.calls.length, 1, 'GoTrue must be asked exactly once per request');
    assertEquals(gotrue.calls[0].url, `${SUPABASE_URL}/auth/v1/user`);
    assertEquals(gotrue.calls[0].authorization, `Bearer ${FORGED}`);
  });
}

Deno.test('positive control: the same token passes when GoTrue accepts it', async () => {
  const gotrue = stubGoTrue(200);
  const result = await authenticateRequest(rpcRequest('initialize', FORGED), {
    supabaseUrl: SUPABASE_URL,
    anonKey: 'anon-key',
    fetchImpl: gotrue.fetchImpl
  });
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.claims.agent_member_id, 'member-1');
  assertEquals(gotrue.calls.length, 1);
});

Deno.test('any non-200 from GoTrue is a refusal', async () => {
  for (const status of [201, 204, 400, 403, 404, 500, 503]) {
    const gotrue = stubGoTrue(status);
    const result = await authenticateRequest(rpcRequest('ping', FORGED), {
      supabaseUrl: SUPABASE_URL,
      fetchImpl: gotrue.fetchImpl
    });
    assertEquals(result.ok, false, `status ${status} must be refused`);
  }
});

Deno.test('GoTrue unreachable fails closed', async () => {
  const result = await authenticateRequest(rpcRequest('tools/list', FORGED), {
    supabaseUrl: SUPABASE_URL,
    fetchImpl: () => Promise.reject(new Error('connection refused'))
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.status, 401);
});

Deno.test('a missing header or a malformed token is refused without asking GoTrue', async () => {
  for (const token of [null, 'not-a-jwt', 'a.b.c']) {
    const gotrue = stubGoTrue(200);
    const result = await authenticateRequest(rpcRequest('initialize', token), {
      supabaseUrl: SUPABASE_URL,
      fetchImpl: gotrue.fetchImpl
    });
    assertEquals(result.ok, false, `token ${String(token)} must be refused`);
    assertEquals(gotrue.calls.length, 0);
  }
});

Deno.test('index.ts verifies the token before reading the body or dispatching a method', () => {
  const src = Deno.readTextFileSync(new URL('./index.ts', import.meta.url));
  const authCalls = [...src.matchAll(/authenticateRequest\(\s*req\b/g)];
  assertEquals(authCalls.length, 1, 'index.ts must call authenticateRequest with the request exactly once');
  const authAt = authCalls[0].index ?? -1;
  const bodyAt = src.search(/readBoundedText\(\s*req\s*\)/);
  const switchAt = src.search(/switch\s*\(\s*rpc\.method\s*\)/);
  assert(bodyAt >= 0, 'expected index.ts to read the body with readBoundedText(req)');
  assert(switchAt >= 0, 'expected index.ts to dispatch with a switch on rpc.method');
  assert(authAt < bodyAt, 'the token must be verified before the body is read');
  assert(authAt < switchAt, 'the token must be verified before any method is dispatched');
});
