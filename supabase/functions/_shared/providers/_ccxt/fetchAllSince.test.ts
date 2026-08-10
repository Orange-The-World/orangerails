/**
 * Unit tests for fetchAllSince.
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/_shared/providers/_ccxt/fetchAllSince.test.ts
 *
 * fetchAllSince is exported and takes a plain `any` exchange object, so
 * these tests drive it with lightweight fakes rather than loading ccxt@4.4.30.
 *
 * Categories:
 *   1. Bitstamp shape: trades readable, withdrawals PermissionDenied
 *   2. Fatal classes stay fatal (AuthenticationError, RateLimitExceeded, generic)
 *   3. NotSupported: survivable, never counted as denied
 *   4. Empty-but-readable source does not count as denied
 *   5. Source never advertised is not attempted and not reportable
 *   6. Every-source-refused still throws
 */

import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { fetchAllSince } from './index.ts';

// ── Test fixtures ─────────────────────────────────────────────────────────────

/** Minimal raw CCXT trade shape that normalizeTrade accepts. */
const RAW_TRADE = {
  id: 'trade-1',
  symbol: 'BTC/USD',
  side: 'buy',
  cost: 5000,
  price: 50000,
  amount: 0.1,
  timestamp: 1700000000000,
  datetime: '2023-11-14T22:13:20.000Z',
};

/** Minimal raw CCXT deposit shape that normalizeTransfer accepts. */
const RAW_DEPOSIT = {
  id: 'dep-1',
  currency: 'USD',
  amount: 1000,
  timestamp: 1700000001000,
  datetime: '2023-11-14T22:13:21.000Z',
  status: 'ok',
};

/** Minimal raw CCXT withdrawal shape. */
const RAW_WITHDRAWAL = {
  id: 'wd-1',
  currency: 'USD',
  amount: 200,
  timestamp: 1700000002000,
  datetime: '2023-11-14T22:13:22.000Z',
  status: 'ok',
};

/**
 * Error with a specific CCXT-style e.name.
 * errorClassName() reads e.name (not e.constructor.name) because CCXT ships
 * minified and constructor names are mangled single letters.
 */
function namedError(name: string, message = 'fake'): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

// ── 1. Bitstamp shape ─────────────────────────────────────────────────────────

Deno.test('Bitstamp: trades readable, withdrawals PermissionDenied -> denied=[withdrawals]', async () => {
  const exchange = {
    has: { fetchMyTrades: true, fetchWithdrawals: true },
    fetchMyTrades: async () => [RAW_TRADE],
    fetchWithdrawals: async () => { throw namedError('PermissionDenied'); },
  };
  const { transactions, denied } = await fetchAllSince(exchange, 'bitstamp', undefined);
  assertEquals(denied, ['withdrawals']);
  assertEquals(transactions.length, 1);
  assertEquals(transactions[0].id, 'trade-trade-1');
});

Deno.test('Bitstamp: trades + deposits readable, withdrawals refused -> denied=[withdrawals], both returned', async () => {
  const exchange = {
    has: { fetchMyTrades: true, fetchDeposits: true, fetchWithdrawals: true },
    fetchMyTrades: async () => [RAW_TRADE],
    fetchDeposits: async () => [RAW_DEPOSIT],
    fetchWithdrawals: async () => { throw namedError('PermissionDenied'); },
  };
  const { transactions, denied } = await fetchAllSince(exchange, 'bitstamp', undefined);
  assertEquals(denied, ['withdrawals']);
  assertEquals(transactions.length, 2);
});

// ── 2. Fatal classes stay fatal ───────────────────────────────────────────────

Deno.test('AuthenticationError on trades propagates (not survivable)', async () => {
  const exchange = {
    has: { fetchMyTrades: true },
    fetchMyTrades: async () => { throw namedError('AuthenticationError'); },
  };
  await assertRejects(
    () => fetchAllSince(exchange, 'bitstamp', undefined),
    Error,
    'fake',
  );
});

Deno.test('RateLimitExceeded on trades propagates (not survivable)', async () => {
  const exchange = {
    has: { fetchMyTrades: true },
    fetchMyTrades: async () => { throw namedError('RateLimitExceeded'); },
  };
  await assertRejects(
    () => fetchAllSince(exchange, 'bitstamp', undefined),
    Error,
    'fake',
  );
});

Deno.test('generic Error on trades propagates (no special name, not survivable)', async () => {
  const exchange = {
    has: { fetchMyTrades: true },
    fetchMyTrades: async () => { throw new Error('something broke'); },
  };
  await assertRejects(
    () => fetchAllSince(exchange, 'bitstamp', undefined),
    Error,
    'something broke',
  );
});

// ── 3. NotSupported: survivable, never counted as denied ──────────────────────

Deno.test('NotSupported on withdrawals: skipped silently, not in denied', async () => {
  const exchange = {
    has: { fetchMyTrades: true, fetchWithdrawals: true },
    fetchMyTrades: async () => [RAW_TRADE],
    fetchWithdrawals: async () => { throw namedError('NotSupported'); },
  };
  const { transactions, denied } = await fetchAllSince(exchange, 'bitstamp', undefined);
  assertEquals(denied, []);
  assertEquals(transactions.length, 1);
});

Deno.test('NotSupported via message text: skipped silently, not in denied', async () => {
  const exchange = {
    has: { fetchMyTrades: true, fetchWithdrawals: true },
    fetchMyTrades: async () => [RAW_TRADE],
    fetchWithdrawals: async () => { throw new Error('NotSupported: this endpoint requires a symbol'); },
  };
  const { transactions, denied } = await fetchAllSince(exchange, 'bitstamp', undefined);
  assertEquals(denied, []);
  assertEquals(transactions.length, 1);
});

// ── 4. Empty-but-readable source does not count as denied ─────────────────────

Deno.test('source returns empty array: not in denied, no throw', async () => {
  const exchange = {
    has: { fetchMyTrades: true, fetchWithdrawals: true },
    fetchMyTrades: async () => [],
    fetchWithdrawals: async () => [],
  };
  const { transactions, denied } = await fetchAllSince(exchange, 'bitstamp', undefined);
  assertEquals(denied, []);
  assertEquals(transactions.length, 0);
});

Deno.test('empty readable source + denied source: only the denied source is in denied', async () => {
  const exchange = {
    has: { fetchMyTrades: true, fetchDeposits: true, fetchWithdrawals: true },
    fetchMyTrades: async () => [],
    fetchDeposits: async () => [RAW_DEPOSIT],
    fetchWithdrawals: async () => { throw namedError('PermissionDenied'); },
  };
  const { transactions, denied } = await fetchAllSince(exchange, 'bitstamp', undefined);
  assertEquals(denied, ['withdrawals']);
  assertEquals(transactions.length, 1);
});

// ── 5. Source never advertised: not attempted, not reportable ─────────────────

Deno.test('exchange.has.fetchWithdrawals=false: not attempted, not in denied', async () => {
  const exchange = {
    has: { fetchMyTrades: true, fetchWithdrawals: false },
    fetchMyTrades: async () => [RAW_TRADE],
    fetchWithdrawals: async () => { throw new Error('should not be called'); },
  };
  const { transactions, denied } = await fetchAllSince(exchange, 'bitstamp', undefined);
  assertEquals(denied, []);
  assertEquals(transactions.length, 1);
});

Deno.test('exchange.has={}: no sources attempted, denied=[], no throw', async () => {
  const exchange = { has: {} };
  const { transactions, denied } = await fetchAllSince(exchange, 'bitstamp', undefined);
  assertEquals(denied, []);
  assertEquals(transactions.length, 0);
});

// ── 6. Every-source-refused still throws ─────────────────────────────────────

Deno.test('all three sources PermissionDenied: throws firstDenial', async () => {
  const exchange = {
    has: { fetchMyTrades: true, fetchDeposits: true, fetchWithdrawals: true },
    fetchMyTrades: async () => { throw namedError('PermissionDenied', 'no permission'); },
    fetchDeposits: async () => { throw namedError('PermissionDenied'); },
    fetchWithdrawals: async () => { throw namedError('PermissionDenied'); },
  };
  await assertRejects(
    () => fetchAllSince(exchange, 'bitstamp', undefined),
    Error,
    'no permission',
  );
});

Deno.test('two sources PermissionDenied, third not advertised: all attempted denied, throws', async () => {
  const exchange = {
    has: { fetchMyTrades: true, fetchDeposits: true },
    fetchMyTrades: async () => { throw namedError('PermissionDenied', 'no permission'); },
    fetchDeposits: async () => { throw namedError('PermissionDenied'); },
  };
  await assertRejects(
    () => fetchAllSince(exchange, 'bitstamp', undefined),
    Error,
    'no permission',
  );
});

Deno.test('one readable source + one PermissionDenied: no throw, partial result returned', async () => {
  const exchange = {
    has: { fetchMyTrades: true, fetchWithdrawals: true },
    fetchMyTrades: async () => [RAW_TRADE],
    fetchWithdrawals: async () => { throw namedError('PermissionDenied'); },
  };
  const { transactions, denied } = await fetchAllSince(exchange, 'bitstamp', undefined);
  assertEquals(denied, ['withdrawals']);
  assertEquals(transactions.length, 1);
});

Deno.test('two sources PermissionDenied + one readable: no throw, denied names in order', async () => {
  const exchange = {
    has: { fetchMyTrades: true, fetchDeposits: true, fetchWithdrawals: true },
    fetchMyTrades: async () => { throw namedError('PermissionDenied'); },
    fetchDeposits: async () => { throw namedError('PermissionDenied'); },
    fetchWithdrawals: async () => [RAW_WITHDRAWAL],
  };
  const { transactions, denied } = await fetchAllSince(exchange, 'bitstamp', undefined);
  assertEquals(denied, ['trades', 'deposits']);
  assertEquals(transactions.length, 1);
});
