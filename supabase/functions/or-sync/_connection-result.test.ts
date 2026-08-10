/**
 * The or-sync wiring, executed rather than pattern-matched.
 *
 * Run with:
 *   deno test --no-check -A supabase/functions/or-sync/_connection-result.test.ts
 *
 * These replace three assertions that read index.ts as text and regexed it for
 * the expected lines. That proved the lines were present and nothing about what
 * they produced: a typo inside the object, an inverted condition, or a field
 * spread under the wrong guard would all have passed. The logic now lives in
 * _connection-result.ts precisely so it can be called.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  readSyncCompleteness,
  buildConnectionResult,
} from './_connection-result.ts';

// ─────────────────────────────────────────────────────────────────────────────
// readSyncCompleteness: what the adapter said
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('a complete sync reports nothing missing', () => {
  assertEquals(readSyncCompleteness({}), { partial: false, deniedSources: [] });
});

Deno.test('an adapter that predates these fields is treated as complete', () => {
  // Absent means "cannot under-report", not "unknown". Every adapter that can
  // under-report now says so; treating silence as doubt would flip healthy
  // connections to partial on deploy.
  assertEquals(readSyncCompleteness(undefined), { partial: false, deniedSources: [] });
  assertEquals(readSyncCompleteness(null), { partial: false, deniedSources: [] });
});

Deno.test('a denied source is carried through with the partial flag', () => {
  assertEquals(
    readSyncCompleteness({ partial: true, denied_sources: ['withdrawals'] }),
    { partial: true, deniedSources: ['withdrawals'] },
  );
});

Deno.test('partial without denied sources is still partial', () => {
  // The xpub adapter's address-window exhaustion has no source name to give.
  assertEquals(readSyncCompleteness({ partial: true }), { partial: true, deniedSources: [] });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildConnectionResult: the additive contract
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('a healthy sync returns exactly the three original fields', () => {
  // The load-bearing test. Breaking this is silent: a consumer parsing a shape
  // it did not expect fails at its end, not ours.
  const out = buildConnectionResult('conn-1', 128, '1767312000000', {
    partial: false,
    deniedSources: [],
  });
  assertEquals(Object.keys(out), ['connection_id', 'synced', 'next_cursor']);
  assertEquals(out, { connection_id: 'conn-1', synced: 128, next_cursor: '1767312000000' });
});

Deno.test('a denied source appears on the result with partial', () => {
  const out = buildConnectionResult('conn-1', 128, '1767312000000', {
    partial: true,
    deniedSources: ['withdrawals'],
  });
  assertEquals(out, {
    connection_id: 'conn-1',
    synced: 128,
    next_cursor: '1767312000000',
    partial: true,
    denied_sources: ['withdrawals'],
  });
});

Deno.test('the Bitstamp shape: trades synced, withdrawals refused', () => {
  const out = buildConnectionResult(
    'e007eb5a-3288-4752-9257-350dbce515b2',
    128,
    '1767312000000',
    readSyncCompleteness({ partial: true, denied_sources: ['withdrawals'] }),
  );
  assertEquals(out.partial, true);
  assertEquals(out.denied_sources, ['withdrawals']);
  assertEquals(out.synced, 128, 'the trades that DID read must still be reported');
});

Deno.test('denied sources force partial even if the adapter forgot to set it', () => {
  // Trusting the flag alone would write status='active' over history nobody
  // read. The stricter of the two signals wins.
  const out = buildConnectionResult('conn-1', 5, null, {
    partial: false,
    deniedSources: ['deposits'],
  });
  assertEquals(out.partial, true);
});

Deno.test('partial with no denied sources omits denied_sources entirely', () => {
  const out = buildConnectionResult('conn-1', 5, null, { partial: true, deniedSources: [] });
  assertEquals(Object.keys(out), ['connection_id', 'synced', 'next_cursor', 'partial']);
  assertEquals('denied_sources' in out, false, 'an empty array must not reach the wire');
});

Deno.test('a zero-row partial sync still reports itself', () => {
  // Every source refused but one read clean and was empty. Zero rows is not
  // the same as a failure, and it must not read as a healthy sync either.
  const out = buildConnectionResult('conn-1', 0, null, {
    partial: true,
    deniedSources: ['withdrawals', 'deposits'],
  });
  assertEquals(out.synced, 0);
  assertEquals(out.partial, true);
  assertEquals(out.denied_sources, ['withdrawals', 'deposits']);
});

Deno.test('a null cursor is preserved, not dropped', () => {
  // or-sync refuses to bank a null cursor; it has to arrive as null to be
  // refused, so silently omitting it here would rewind the sync window.
  const out = buildConnectionResult('conn-1', 3, null, { partial: false, deniedSources: [] });
  assertEquals(out.next_cursor, null);
  assertEquals('next_cursor' in out, true);
});

Deno.test('junk in denied_sources is dropped rather than echoed to the wire', () => {
  const out = buildConnectionResult('conn-1', 1, null, {
    partial: false,
    // deno-lint-ignore no-explicit-any
    deniedSources: ['withdrawals', '', null as any, undefined as any],
  });
  assertEquals(out.denied_sources, ['withdrawals']);
});
