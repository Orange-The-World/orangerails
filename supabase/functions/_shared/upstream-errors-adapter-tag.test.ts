/**
 * Deno tests for tagAdapterError (OR-T2777).
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/_shared/upstream-errors-adapter-tag.test.ts
 *
 * A wrong Strike key at connect reached the customer as a 500 "Internal error"
 * because only the _ccxt adapter tags its errors with upstreamCode, and
 * or-discover-wallets maps an error to customer copy only when that tag is
 * present. Measured on Orange Rails dev 2026-11-03/04: 12 POSTs answered 500
 * with "fatal code=UPSTREAM_AUTH_FAILED" in the log.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { tagAdapterError } from './upstream-errors.ts';

type Tagged = Error & { upstreamCode?: string };

// Real wire shape of the Strike adapter's error (strike/index.ts strikeGet).
const strike = (status: number, body = '{"data":{"status":401,"code":"UNAUTHORIZED"}}') =>
  new Error(`Strike ${status} GET /v1/balances: ${body}`);

Deno.test('a Strike 401 is tagged UPSTREAM_AUTH_FAILED', () => {
  const e = tagAdapterError(strike(401)) as Tagged;
  assertEquals(e.upstreamCode, 'UPSTREAM_AUTH_FAILED');
});

Deno.test('a Strike 429 is tagged UPSTREAM_RATE_LIMITED', () => {
  const e = tagAdapterError(strike(429, 'Too Many Requests')) as Tagged;
  assertEquals(e.upstreamCode, 'UPSTREAM_RATE_LIMITED');
});

Deno.test('a Strike 503 is tagged UPSTREAM_UNAVAILABLE', () => {
  const e = tagAdapterError(strike(503, 'Service Unavailable')) as Tagged;
  assertEquals(e.upstreamCode, 'UPSTREAM_UNAVAILABLE');
});

Deno.test('an adapter config error is left untagged, so the caller keeps its 500', () => {
  const e = tagAdapterError(new Error('[strike] credentials.api_key required')) as Tagged;
  assertEquals(e.upstreamCode, undefined);
});

Deno.test('a credential JSON parse failure is left untagged', () => {
  let parseErr: unknown;
  try { JSON.parse('not json at all'); } catch (x) { parseErr = x; }
  const e = tagAdapterError(parseErr) as Tagged;
  assertEquals(e.upstreamCode, undefined);
});

Deno.test('an existing upstreamCode (the _ccxt path) is never overwritten', () => {
  const e = strike(401) as Tagged;
  e.upstreamCode = 'UPSTREAM_UNSUPPORTED';
  assertEquals((tagAdapterError(e) as Tagged).upstreamCode, 'UPSTREAM_UNSUPPORTED');
});

Deno.test('the same error object is returned and its message is untouched', () => {
  const original = strike(401);
  const msg = original.message;
  assert(tagAdapterError(original) === original);
  assertEquals(original.message, msg);
});

Deno.test('a non-Error throw passes through unchanged', () => {
  assertEquals(tagAdapterError('boom'), 'boom');
});

// Wiring guard: or-discover-wallets calls Deno.serve at import, so it cannot be
// imported here. Read its source instead and require that every adapter call
// goes through tagAdapterError. Without this, the helper could exist and the
// handler still answer a wrong key with "Internal error".
Deno.test('or-discover-wallets routes every adapter.discoverWallets call through tagAdapterError', async () => {
  const src = await Deno.readTextFile(
    new URL('../or-discover-wallets/index.ts', import.meta.url),
  );
  const calls = src.match(/adapter\.discoverWallets\([^)]*\)[^;]*;/g) ?? [];
  assert(calls.length >= 2, `expected the two adapter calls, found ${calls.length}`);
  for (const c of calls) {
    assert(c.includes('tagAdapterError'), `untagged adapter call: ${c}`);
  }
});
