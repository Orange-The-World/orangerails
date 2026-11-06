/**
 * Deno tests for tagAdapterError and withHttpStatus (OR-T2777).
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/_shared/upstream-errors-adapter-tag.test.ts
 *
 * A wrong Strike key at connect reached the customer as a 500 "Internal error"
 * because only the _ccxt adapter tags its errors with upstreamCode, and
 * or-discover-wallets maps an error to customer copy only when that tag is
 * present. Measured on Orange Rails dev 2026-11-03/04: 12 POSTs answered 500
 * with "fatal code=UPSTREAM_AUTH_FAILED" in the log.
 *
 * The tag is decided by the provider's HTTP status alone, never the message:
 * a review of the first version showed a 429 whose body said 401 read as a
 * rejected key, a JSON parse error at offset 503 read as an outage, and Surge's
 * "[surge:http_401]" never matched at all.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { tagAdapterError, withHttpStatus } from './upstream-errors.ts';
import { strikeAdapter } from './providers/strike/index.ts';

type Tagged = Error & { upstreamCode?: string; httpStatus?: number };
const tag = (e: unknown) => tagAdapterError(e) as Tagged;
const http = (status: number, msg = `Provider ${status}`) => withHttpStatus(new Error(msg), status);

Deno.test('401 and 403 are a rejected key', () => {
  assertEquals(tag(http(401)).upstreamCode, 'UPSTREAM_AUTH_FAILED');
  assertEquals(tag(http(403)).upstreamCode, 'UPSTREAM_AUTH_FAILED');
});

Deno.test('429 is a rate limit, 5xx is an outage', () => {
  assertEquals(tag(http(429)).upstreamCode, 'UPSTREAM_RATE_LIMITED');
  for (const s of [500, 502, 503, 504]) assertEquals(tag(http(s)).upstreamCode, 'UPSTREAM_UNAVAILABLE');
});

Deno.test('other statuses stay untagged, so the caller keeps its 500', () => {
  for (const s of [200, 400, 404, 409, 422]) assertEquals(tag(http(s)).upstreamCode, undefined);
});

Deno.test('the status wins over a body that says something else (429 body says 401)', () => {
  const e = http(429, 'Strike 429 GET /balances: {"status":401,"code":"UNAUTHORIZED"}');
  assertEquals(tag(e).upstreamCode, 'UPSTREAM_RATE_LIMITED');
  const f = http(503, 'BTCPay 503 /stores: upstream said 403 Forbidden');
  assertEquals(tag(f).upstreamCode, 'UPSTREAM_UNAVAILABLE');
});

Deno.test('Surge-shaped message with the status carried is tagged', () => {
  assertEquals(tag(http(401, '[surge:http_401] Bad signature')).upstreamCode, 'UPSTREAM_AUTH_FAILED');
  assertEquals(tag(http(429, '[surge:http_429] Slow down')).upstreamCode, 'UPSTREAM_RATE_LIMITED');
});

Deno.test('an error with no status is never tagged from its text', () => {
  assertEquals(tag(new Error('Strike 401 GET /v1/balances: Unauthorized')).upstreamCode, undefined);
  let parseErr: unknown;
  try { JSON.parse('{"a":1' + ' '.repeat(497) + 'x}'); } catch (x) { parseErr = x; }
  assertEquals(tag(parseErr).upstreamCode, undefined);
  assertEquals(tag(new Error('[strike] credentials.api_key required')).upstreamCode, undefined);
});

Deno.test('an existing upstreamCode (the _ccxt path) is never overwritten', () => {
  const e = http(401) as Tagged;
  e.upstreamCode = 'UPSTREAM_UNSUPPORTED';
  assertEquals(tag(e).upstreamCode, 'UPSTREAM_UNSUPPORTED');
});

Deno.test('same object back, message untouched; a non-Error passes through', () => {
  const original = http(401, 'Strike 401 GET /x: body');
  assert(tagAdapterError(original) === original);
  assertEquals(original.message, 'Strike 401 GET /x: body');
  assertEquals(tagAdapterError('boom'), 'boom');
});

// Behavioural: the real Strike adapter, with Strike answering 429 and a body that
// mentions 401. The error must carry the status and tag as a rate limit.
Deno.test('Strike adapter: a 429 reply carries httpStatus 429 and tags as rate limited', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response('{"data":{"status":401,"code":"UNAUTHORIZED"}}', { status: 429 }));
  try {
    let caught: unknown;
    try {
      await strikeAdapter.discoverWallets({ api_key: 'test-key-not-real' });
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof Error, 'discoverWallets must throw on a 429');
    assertEquals((caught as Tagged).httpStatus, 429);
    assertEquals(tag(caught).upstreamCode, 'UPSTREAM_RATE_LIMITED');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Source guards. or-discover-wallets calls Deno.serve at import, and most adapters
// need live credentials, so these read the source.
const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));

Deno.test('or-discover-wallets routes every adapter.discoverWallets call through tagAdapterError', async () => {
  const src = await read('../or-discover-wallets/index.ts');
  const calls = src.match(/adapter\.discoverWallets\([^)]*\)[^;]*;/g) ?? [];
  assert(calls.length >= 2, `expected the two adapter calls, found ${calls.length}`);
  for (const c of calls) assert(c.includes('tagAdapterError'), `untagged adapter call: ${c}`);
});

Deno.test('every provider HTTP-status error in the five adapters carries its status', async () => {
  for (const p of ['strike', 'blink', 'btcpay', 'surge', 'xpub']) {
    const src = await read(`./providers/${p}/index.ts`);
    const throws = src.match(/throw [^;]*res\.status[^;]*;/g) ?? [];
    const surgeThrow = p === 'surge' ? (src.match(/throw [^;]*\[surge:\$\{code\}\][^;]*;/g) ?? []) : [];
    const all = [...throws, ...surgeThrow];
    assert(all.length >= 1, `${p}: expected at least one HTTP error throw`);
    for (const t of all) assert(t.includes('withHttpStatus('), `${p}: status not carried: ${t}`);
  }
});
