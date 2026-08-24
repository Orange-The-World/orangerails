/**
 * DL-1562: the dispatcher must not be invocable without the worker token.
 *
 * Run with:
 *   deno test --no-check --allow-read supabase/functions/or-webhook-dispatch/auth-guard.test.ts
 *
 * Source assertions rather than handler invocation. The handler is passed
 * straight to Deno.serve and is not exported, so there is nothing to call; and
 * the guard's dependencies (a service client, a Vault RPC) would have to be
 * mocked so completely that the test would be asserting on the mock. The
 * existing index.test.ts covers dispatchBatch behaviourally, which is the part
 * where mocking earns its keep. This file covers the part that is structural.
 *
 * WHY IT NEEDS PINNING. Before this change the handler ignored the request
 * entirely: its signature was `_req`, and it was safe only because the function
 * had no config.toml entry and so inherited verify_jwt = true. Wiring it to
 * pg_cron requires verify_jwt = false, because pg_cron has no user JWT to
 * present. That removes the platform gate. If the guard is ever deleted while
 * the config entry stays, this function becomes an unauthenticated endpoint
 * that drains a queue and sends signed payloads to integrator endpoints. The
 * two changes have to stay together, so this file asserts on both files.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

const src = Deno.readTextFileSync(new URL('./index.ts', import.meta.url));
const cfg = Deno.readTextFileSync(
  new URL('../../config.toml', import.meta.url),
);

Deno.test('the handler reads the request instead of ignoring it', () => {
  // `_req` is the old signature. An underscore-prefixed parameter is the
  // convention for "deliberately unused", so its presence here would mean the
  // guard is gone rather than merely refactored.
  assertEquals(
    /Deno\.serve\(wrapSentryHandler\(async \(_req/.test(src),
    false,
    'handler still ignores the request: the auth guard is missing',
  );
  assertEquals(
    /Deno\.serve\(wrapSentryHandler\(async \(req: Request\)/.test(src),
    true,
    'handler should take the request so it can read the token header',
  );
});

Deno.test('an unauthenticated or wrong-token call is rejected 401', () => {
  assertEquals(
    /X-Internal-Worker-Token/.test(src),
    true,
    'the worker token header must be read',
  );
  assertEquals(
    /timingSafeEqual\(callerToken, expected\)/.test(src),
    true,
    'token comparison must be constant-time, not ===',
  );
  assertEquals(
    /!callerToken \|\| !timingSafeEqual/.test(src),
    true,
    'a missing token must be rejected as well as a wrong one',
  );
  assertEquals(
    /jsonResponse\(\{ error: 'unauthorized' \}, 401\)/.test(src),
    true,
    'a failed token check must return 401',
  );
});

Deno.test('the guard runs before the queue is drained', () => {
  // Ordering matters: draining first and checking later would still send the
  // webhooks. Assert the 401 return appears before the dispatchBatch call.
  const guardAt = src.indexOf("jsonResponse({ error: 'unauthorized' }, 401)");
  const drainAt = src.indexOf('await dispatchBatch({ serviceClient })');
  assertEquals(guardAt > -1 && drainAt > -1, true, 'expected both the guard and the drain call');
  assertEquals(
    guardAt < drainAt,
    true,
    'the auth guard must return before dispatchBatch runs, not after',
  );
});

Deno.test('a missing vault secret fails closed, not open', () => {
  // If the Vault read errors or returns nothing we must refuse, never fall
  // through to an unguarded drain. 503 rather than 401 because the fault is
  // ours, not the caller's, and it should page rather than look like abuse.
  assertEquals(
    /jsonResponse\(\{ error: 'vault read error' \}, 503\)/.test(src),
    true,
    'a Vault RPC error must return 503',
  );
  assertEquals(
    /jsonResponse\(\{ error: 'worker token missing from vault' \}, 503\)/.test(src),
    true,
    'an empty Vault secret must return 503 rather than accepting the caller',
  );
});

Deno.test('non-POST is refused', () => {
  assertEquals(
    /req\.method !== 'POST'/.test(src),
    true,
    'only POST should reach the drain',
  );
});

Deno.test('config.toml and the guard ship together', () => {
  // The dangerous state is verify_jwt = false with no guard. This asserts the
  // config entry exists, which is what makes the guard load-bearing; the tests
  // above assert the guard exists. Together they fail if either half is
  // removed on its own.
  const block = /\[functions\.or-webhook-dispatch\]\s*\nverify_jwt = false/.test(cfg);
  assertEquals(
    block,
    true,
    'or-webhook-dispatch needs verify_jwt = false to be reachable from pg_cron',
  );
});
