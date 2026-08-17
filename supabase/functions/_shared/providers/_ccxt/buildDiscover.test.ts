/**
 * Unit tests for buildDiscover's fetchBalance guard.
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/_shared/providers/_ccxt/buildDiscover.test.ts
 *
 * Tests drive _discoverExchange directly (the test seam) to avoid loading
 * npm:ccxt@4.4.30 at test time. Same pattern as fetchAllSince.test.ts.
 *
 * Categories:
 *   1. Exchange without fetchBalance -> UPSTREAM_UNSUPPORTED thrown
 *   2. Exchange with fetchBalance that succeeds -> wallet returned with account_key
 *   3. Exchange with fetchBalance that fails auth -> UPSTREAM_AUTH_FAILED propagated
 */

import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { _discoverExchange } from './index.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

function namedError(name: string, message = 'fake'): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

// ── 1. Exchange without fetchBalance: UPSTREAM_UNSUPPORTED ────────────────────

Deno.test('buildDiscover: exchange.has.fetchBalance=false -> throws UPSTREAM_UNSUPPORTED', async () => {
  const exchange = { has: { fetchBalance: false } };
  const err = await assertRejects(
    () => _discoverExchange('kraken', 'kraken', exchange, {}),
    Error,
    'UPSTREAM_UNSUPPORTED',
  );
  assertEquals((err as any).upstreamCode, 'UPSTREAM_UNSUPPORTED');
});

Deno.test('buildDiscover: exchange.has without fetchBalance key -> throws UPSTREAM_UNSUPPORTED', async () => {
  // An exchange that simply does not list fetchBalance in has{} at all.
  const exchange = { has: { fetchMyTrades: true } };
  const err = await assertRejects(
    () => _discoverExchange('bitstamp', 'bitstamp', exchange, {}),
    Error,
    'UPSTREAM_UNSUPPORTED',
  );
  assertEquals((err as any).upstreamCode, 'UPSTREAM_UNSUPPORTED');
});

// ── 2. Exchange with fetchBalance succeeds: wallet returned ───────────────────

Deno.test('buildDiscover: fetchBalance succeeds -> returns wallet with account_key', async () => {
  const exchange = {
    has: { fetchBalance: true },
    fetchBalance: async () => ({ total: {} }),
  };
  const wallets = await _discoverExchange('kraken', 'kraken', exchange, { apiKey: 'testapikey' });
  assertEquals(wallets.length, 1);
  assertEquals(wallets[0].external_wallet_id, 'kraken');
  // account_key must be a non-empty hex string (sha256 of exchangeId:apiKey).
  assertEquals(typeof wallets[0].account_key, 'string');
  assertEquals((wallets[0].account_key as string).length, 64);
});

// ── 3. Exchange with fetchBalance that throws auth error ──────────────────────

Deno.test('buildDiscover: fetchBalance throws AuthenticationError -> propagates with UPSTREAM_AUTH_FAILED', async () => {
  const exchange = {
    has: { fetchBalance: true },
    fetchBalance: async () => { throw namedError('AuthenticationError', 'invalid key'); },
  };
  const err = await assertRejects(
    () => _discoverExchange('kraken', 'kraken', exchange, {}),
    Error,
  );
  assertEquals((err as any).upstreamCode, 'UPSTREAM_AUTH_FAILED');
});
