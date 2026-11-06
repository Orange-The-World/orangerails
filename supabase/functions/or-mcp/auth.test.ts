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
 * Deadline (OR-T0421 step 5): a GoTrue that never answers is refused with 401
 * inside the deadline. The stub honours the abort signal; the test fails if the
 * call is not aborted or the refusal takes 400 ms or more.
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

// 204, 205 and 304 are null-body statuses. The Response constructor throws if it is
// given a body with one of them. That would make a stubbed GoTrue answer of 204 look
// like a thrown error: refused by the catch, never reaching the status comparison.
// The answered list records each status the stub really returned, so a test can prove it.
function stubGoTrue(status: number) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const answered: number[] = [];
  const nullBody = status === 204 || status === 205 || status === 304;
  const fetchImpl = (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    calls.push({ url, authorization: headers.get('Authorization') });
    const res = new Response(nullBody ? null : JSON.stringify({ msg: 'stub' }), { status });
    answered.push(status);
    return Promise.resolve(res);
  };
  return { fetchImpl, calls, answered };
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
  for (const status of [201, 204, 400, 403, 404, 429, 500, 503]) {
    const gotrue = stubGoTrue(status);
    const result = await authenticateRequest(rpcRequest('ping', FORGED), {
      supabaseUrl: SUPABASE_URL,
      fetchImpl: gotrue.fetchImpl
    });
    assertEquals(result.ok, false, `status ${status} must be refused`);
    assertEquals(gotrue.answered, [status], `the stub must answer ${status}, not throw, so the refusal comes from the status check`);
  }
});

Deno.test('GoTrue unreachable fails closed and logs one fixed line', async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    const result = await authenticateRequest(rpcRequest('tools/list', FORGED), {
      supabaseUrl: SUPABASE_URL,
      fetchImpl: () => Promise.reject(new Error('connection refused'))
    });
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.status, 401);
  } finally {
    console.warn = originalWarn;
  }
  assertEquals(warnings.length, 1, 'an unreachable GoTrue must leave exactly one log line');
  assert(!warnings[0].includes('connection refused'), 'the log line must not carry the error text');
  assert(!warnings[0].includes(FORGED), 'the log line must not carry the token');
});

Deno.test('a GoTrue that never answers is refused with 401 inside the deadline', async () => {
  let aborted = false;
  let safety: number | undefined;
  const hangingFetch = (_url: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      // Safety net: if the code under test sets no deadline, answer 200 after a
      // second so this test fails on the assertions below instead of hanging CI.
      safety = setTimeout(() => resolve(new Response('{}', { status: 200 })), 1000);
      init.signal?.addEventListener('abort', () => {
        aborted = true;
        clearTimeout(safety);
        reject(new DOMException('The signal has been aborted', 'AbortError'));
      });
    });
  const started = performance.now();
  try {
    const result = await authenticateRequest(rpcRequest('initialize', FORGED), {
      supabaseUrl: SUPABASE_URL,
      anonKey: 'anon-key',
      fetchImpl: hangingFetch
    });
    const elapsed = performance.now() - started;
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.status, 401);
    assert(aborted, 'the call to GoTrue must be aborted, not left hanging');
    assert(elapsed < 400, `expected a refusal in under 400 ms, took ${Math.round(elapsed)} ms`);
  } finally {
    clearTimeout(safety);
  }
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
