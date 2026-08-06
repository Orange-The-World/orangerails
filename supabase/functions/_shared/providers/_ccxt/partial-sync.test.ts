/**
 * One refused CCXT source must not discard the sources that succeeded.
 *
 * Run with:
 *   deno test --no-check -A supabase/functions/_shared/providers/_ccxt/partial-sync.test.ts
 *
 * The bug these pin: fetchAllSince rethrew anything that was not
 * NotSupported, so a PermissionDenied on `fetchWithdrawals` aborted the whole
 * sweep and threw away the trades already fetched. A Bitstamp connection with
 * a read-only API key could read its entire trade history and still sync zero
 * rows, reporting UPSTREAM_AUTH_FAILED and telling the customer to reconnect,
 * which can never fix a missing key permission.
 *
 * fetchAllSince takes a duck-typed `exchange`, so these drive it directly with
 * a fake rather than reading the source as text. ccxt itself is imported
 * lazily inside instantiateExchange and is never loaded by this file.
 */

import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { fetchAllSince } from './index.ts';

/**
 * CCXT ships minified, so errorClassName reads `.name` rather than the
 * constructor. A fake carrying the class name is what the real thing looks
 * like to our code.
 */
function ccxtError(name: string, message = 'fake'): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

const TRADE = {
  id: 't1',
  symbol: 'BTC/USD',
  timestamp: Date.UTC(2026, 0, 2),
  datetime: '2026-01-02T00:00:00.000Z',
  side: 'buy',
  amount: 0.5,
  price: 60000,
  cost: 30000,
};

const WITHDRAWAL = {
  id: 'w1',
  timestamp: Date.UTC(2026, 0, 3),
  datetime: '2026-01-03T00:00:00.000Z',
  currency: 'BTC',
  amount: 0.1,
  status: 'ok',
};

/** An exchange that advertises all three sources; each behaviour is injected. */
function fakeExchange(behaviour: {
  trades?: () => unknown[];
  deposits?: () => unknown[];
  withdrawals?: () => unknown[];
  has?: Record<string, boolean>;
}) {
  return {
    has: behaviour.has ?? { fetchMyTrades: true, fetchDeposits: true, fetchWithdrawals: true },
    fetchMyTrades: () => Promise.resolve(behaviour.trades ? behaviour.trades() : []),
    fetchDeposits: () => Promise.resolve(behaviour.deposits ? behaviour.deposits() : []),
    fetchWithdrawals: () => Promise.resolve(behaviour.withdrawals ? behaviour.withdrawals() : []),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The Bitstamp case: read-only key, withdrawals refused, trades readable.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('a refused source keeps the rows the other sources returned', async () => {
  const out = await fetchAllSince(
    fakeExchange({
      trades: () => [TRADE],
      withdrawals: () => {
        throw ccxtError('PermissionDenied', 'bitstamp No permission found');
      },
    }),
    'bitstamp',
    undefined,
  );

  assertEquals(out.transactions.length, 1, 'the readable trade must survive the refusal');
  assertEquals(out.transactions[0].type, 'trade');
  assertEquals(out.denied, ['withdrawals'], 'the refused source must be named');
});

Deno.test('a refused source is reported so the caller can mark the sync partial', async () => {
  const out = await fetchAllSince(
    fakeExchange({
      trades: () => [TRADE],
      deposits: () => {
        throw ccxtError('PermissionDenied');
      },
      withdrawals: () => {
        throw ccxtError('PermissionDenied');
      },
    }),
    'bitstamp',
    undefined,
  );

  assertEquals(out.transactions.length, 1);
  assertEquals(out.denied, ['deposits', 'withdrawals']);
});

Deno.test('nothing is marked denied when every source succeeds', async () => {
  const out = await fetchAllSince(
    fakeExchange({ trades: () => [TRADE], withdrawals: () => [WITHDRAWAL] }),
    'bitstamp',
    undefined,
  );

  assertEquals(out.transactions.length, 2);
  assertEquals(out.denied, [], 'a clean sweep must not report partial');
});

// ─────────────────────────────────────────────────────────────────────────────
// A source that read fine and found nothing is NOT the same as one refused.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('an empty but readable source does not make the sync partial', async () => {
  const out = await fetchAllSince(
    fakeExchange({
      trades: () => [],
      deposits: () => [],
      withdrawals: () => {
        throw ccxtError('PermissionDenied');
      },
    }),
    'bitstamp',
    undefined,
  );

  assertEquals(out.transactions.length, 0);
  assertEquals(
    out.denied,
    ['withdrawals'],
    'trades and deposits genuinely read and were empty, so this is partial, not fatal',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Nothing readable at all stays a hard failure.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('a key that can read no source at all still throws', async () => {
  await assertRejects(
    () =>
      fetchAllSince(
        fakeExchange({
          trades: () => {
            throw ccxtError('PermissionDenied');
          },
          deposits: () => {
            throw ccxtError('PermissionDenied');
          },
          withdrawals: () => {
            throw ccxtError('PermissionDenied');
          },
        }),
        'bitstamp',
        undefined,
      ),
    Error,
    undefined,
    'every source refused and no rows read: a partial success of zero rows would hide it',
  );
});

Deno.test('a single-source exchange that refuses still throws', async () => {
  await assertRejects(
    () =>
      fetchAllSince(
        fakeExchange({
          has: { fetchMyTrades: true },
          trades: () => {
            throw ccxtError('PermissionDenied');
          },
        }),
        'gemini',
        undefined,
      ),
    Error,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Everything that is not a per-source permission problem stays fatal.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('AuthenticationError is fatal, not a skipped source', async () => {
  await assertRejects(
    () =>
      fetchAllSince(
        fakeExchange({
          trades: () => [TRADE],
          withdrawals: () => {
            throw ccxtError('AuthenticationError', 'invalid signature');
          },
        }),
        'bitstamp',
        undefined,
      ),
    Error,
    'invalid signature',
    'a rejected credential fails every source, so "reconnect" is the right advice',
  );
});

Deno.test('a rate limit is fatal, so the retry refetches instead of advancing the cursor', async () => {
  await assertRejects(
    () =>
      fetchAllSince(
        fakeExchange({
          trades: () => [TRADE],
          withdrawals: () => {
            throw ccxtError('RateLimitExceeded');
          },
        }),
        'bitstamp',
        undefined,
      ),
    Error,
  );
});

Deno.test('an exchange outage is fatal', async () => {
  await assertRejects(
    () =>
      fetchAllSince(
        fakeExchange({
          trades: () => [TRADE],
          withdrawals: () => {
            throw ccxtError('ExchangeNotAvailable');
          },
        }),
        'bitstamp',
        undefined,
      ),
    Error,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// NotSupported keeps its existing behaviour: skipped, and NOT partial.
//
// CCXT having no implementation is a fixed property of the exchange, not a
// fault, and it was already skipped silently. Counting it as partial would
// flip a large number of healthy connections to `partial` on deploy for a
// reason no customer can act on.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('NotSupported is skipped without making the sync partial', async () => {
  const out = await fetchAllSince(
    fakeExchange({
      trades: () => [TRADE],
      withdrawals: () => {
        throw ccxtError('NotSupported');
      },
    }),
    'bitfinex',
    undefined,
  );

  assertEquals(out.transactions.length, 1);
  assertEquals(out.denied, [], 'NotSupported must not be reported as denied');
});

Deno.test('NotSupported carried only in the message is still skipped', async () => {
  const out = await fetchAllSince(
    fakeExchange({
      trades: () => {
        throw new Error('bitfinex fetchMyTrades NotSupported without a symbol');
      },
      withdrawals: () => [WITHDRAWAL],
    }),
    'bitfinex',
    undefined,
  );

  assertEquals(out.transactions.length, 1);
  assertEquals(out.denied, []);
});

Deno.test('a source the exchange does not advertise is never attempted', async () => {
  const out = await fetchAllSince(
    fakeExchange({
      has: { fetchMyTrades: true, fetchDeposits: false, fetchWithdrawals: false },
      trades: () => [TRADE],
      withdrawals: () => {
        throw ccxtError('PermissionDenied');
      },
    }),
    'bitstamp',
    undefined,
  );

  assertEquals(out.transactions.length, 1);
  assertEquals(out.denied, [], 'withdrawals was never called, so it cannot be denied');
});

// ─────────────────────────────────────────────────────────────────────────────
// The wiring from `denied` to SyncResult.partial. syncByWallets itself calls
// instantiateExchange, which loads ccxt, so this joint is guarded at the
// source level in the same style as index.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('syncByWallets maps a denied source to partial + denied_sources', () => {
  const src = Deno.readTextFileSync(new URL('./index.ts', import.meta.url));

  assertEquals(
    /denied\.length\s*>\s*0\s*\?\s*\{\s*partial:\s*true,\s*denied_sources:\s*denied\s*\}/.test(src),
    true,
    'syncByWallets must set partial:true and denied_sources, or or-sync writes status=active over incomplete history and the consumer cannot say what is missing',
  );
});

// or-sync's half of the wiring is NOT guarded here any more. It was three
// regexes over index.ts, which proved the lines existed and nothing about what
// they produced. That logic now lives in or-sync/_connection-result.ts and is
// executed by _connection-result.test.ts.

Deno.test('a healthy sync response gains no new fields', async () => {
  // The additive contract in one assertion: nothing denied means the spread
  // contributes nothing, so existing consumers see the exact shape they read
  // before. Guarded here because a regression would be silent and would only
  // surface as a consumer parsing something it did not expect.
  const out = await fetchAllSince(
    fakeExchange({ trades: () => [TRADE] }),
    'kraken',
    undefined,
  );

  assertEquals(out.denied.length, 0);
  assertEquals(
    Object.keys({
      connection_id: 'x',
      synced: 1,
      next_cursor: '1',
      ...(out.denied.length > 0 ? { partial: true, denied_sources: out.denied } : {}),
    }),
    ['connection_id', 'synced', 'next_cursor'],
  );
});
