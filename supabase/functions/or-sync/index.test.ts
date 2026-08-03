/**
 * Deno tests for or-sync.
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/or-sync/index.test.ts
 *
 * Covers mergeStrikeTransactions, the poll+drain merge that feeds the single
 * ON CONFLICT DO UPDATE upsert. Two separate defects live here and both are
 * silent in production if they regress, so they are pinned:
 *
 *   1. Duplicate external_id in one batch -> SQLSTATE 21000, the whole batch
 *      aborts, and any payment.* in it is lost permanently (drainStrikeQueue
 *      already wrote processed_at; Strike has no list endpoint for outgoing
 *      Lightning payments).
 *   2. Whole-record drain-wins downgrading a correct source_wallet_id to null,
 *      which does not self-heal because the cursor advances past it. The
 *      recovery is GUARDED to single-synced-wallet connections: on a
 *      multi-wallet connection the poll's walletIds[0] is a guess, and
 *      preferring it would mis-file rather than under-file.
 */

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { mergeStrikeTransactions, batchHttpStatus, throwOnDbError } from './index.ts';
import type { NormalizedTransaction } from '../_shared/providers/dispatch.ts';

const WALLET_A = 'wallet-aaaa';
const WALLET_B = 'wallet-bbbb';

function tx(
  id: string,
  source_wallet_id: string | null,
  extra: Partial<NormalizedTransaction> = {},
): NormalizedTransaction {
  return {
    id,
    adapter: 'strike',
    direction: 'in',
    type: 'lightning',
    amount: 100,
    currency: 'USD',
    description: null,
    counterparty: null,
    status: 'PAID',
    timestamp: '2026-07-26T00:00:00.000Z',
    source_wallet_id,
    ...extra,
  } as NormalizedTransaction;
}

// ── 1. Dedupe: the 21000 guard ────────────────────────────────────────

Deno.test('merge: same id from poll and drain collapses to one row', () => {
  const out = mergeStrikeTransactions(
    [tx('inv-1', null)],
    [tx('inv-1', WALLET_A)],
    [WALLET_A],
  );
  assertEquals(out.length, 1);
  assertEquals(out[0].source_wallet_id, WALLET_A);
});

Deno.test('merge: invoice.created + invoice.updated in one drain batch collapse to one row', () => {
  // Both events GET-by-id to the same invoice, so normalizeInvoice returns the
  // same id twice. Two identical external_ids in one upsert is the 21000 case.
  const out = mergeStrikeTransactions(
    [],
    [tx('inv-DUP', WALLET_A, { status: 'PENDING' }), tx('inv-DUP', WALLET_A, { status: 'PAID' })],
    [WALLET_A],
  );
  assertEquals(out.length, 1);
  assertEquals(out[0].status, 'PAID', 'last drain record wins');
});

Deno.test('merge: every external_id in the output is unique', () => {
  const out = mergeStrikeTransactions(
    [tx('a', WALLET_A), tx('b', WALLET_A), tx('c', WALLET_A)],
    [tx('a', WALLET_A), tx('a', WALLET_A), tx('d', null), tx('b', WALLET_A)],
    [WALLET_A],
  );
  const ids = out.map((t) => t.id);
  assertEquals(new Set(ids).size, ids.length);
  assertEquals(ids.sort(), ['a', 'b', 'c', 'd']);
});

Deno.test('merge: poll-only and drain-only rows are both preserved', () => {
  const out = mergeStrikeTransactions(
    [tx('poll-only', WALLET_A)],
    [tx('payment:webhook-only', null)],
    [WALLET_A],
  );
  assertEquals(out.map((t) => t.id).sort(), ['payment:webhook-only', 'poll-only']);
});

// ── 2. Drain-wins, and the GUARDED attribution fallback ───────────────

Deno.test('merge: drain wins wholesale for every field', () => {
  const out = mergeStrikeTransactions(
    [tx('x', WALLET_A, { status: 'PENDING', amount: 1 })],
    [tx('x', WALLET_A, { status: 'PAID', amount: 999 })],
    [WALLET_A],
  );
  assertEquals(out.length, 1);
  assertEquals(out[0].status, 'PAID');
  assertEquals(out[0].amount, 999);
});

Deno.test('merge: non-null drain source_wallet_id always wins over the poll', () => {
  const out = mergeStrikeTransactions(
    [tx('x', WALLET_A)],
    [tx('x', WALLET_B)],
    [WALLET_A, WALLET_B],
  );
  assertEquals(out[0].source_wallet_id, WALLET_B, 'fingerprint attribution is authoritative');
});

Deno.test('merge: SINGLE-wallet connection recovers the poll id when the drain has null', () => {
  // deposit.* / payout.* / receive-request.* / currency-exchange-quote.* always
  // arrive from the drain with null. With one synced wallet that null is a
  // regression, not a fact.
  const out = mergeStrikeTransactions(
    [tx('deposit:d1', WALLET_A)],
    [tx('deposit:d1', null, { status: 'COMPLETED' })],
    [WALLET_A],
  );
  assertEquals(out.length, 1);
  assertEquals(out[0].source_wallet_id, WALLET_A, 'correct attribution must not be downgraded to null');
  assertEquals(out[0].status, 'COMPLETED', 'the rest of the record is still the drain copy');
});

Deno.test('merge: MULTI-wallet connection leaves it null when the drain has null', () => {
  // walletIds[0] is a coin flip across two wallets. Under-attribution is
  // recoverable; mis-attribution is not. This must stay null.
  const out = mergeStrikeTransactions(
    [tx('deposit:d1', WALLET_A)],
    [tx('deposit:d1', null)],
    [WALLET_A, WALLET_B],
  );
  assertEquals(out.length, 1);
  assertEquals(out[0].source_wallet_id, null, 'must NOT guess on a multi-wallet connection');
});

Deno.test('merge: ZERO-wallet (legacy) connection leaves it null', () => {
  const out = mergeStrikeTransactions([tx('deposit:d1', null)], [tx('deposit:d1', null)], []);
  assertEquals(out[0].source_wallet_id, null);
});

Deno.test('merge: drain-only row is never back-filled (no poll copy to trust)', () => {
  const out = mergeStrikeTransactions([], [tx('payment:p1', null)], [WALLET_A]);
  assertEquals(out[0].source_wallet_id, null, 'payment.* has no poll counterpart, stays unattributed');
});

Deno.test('merge: does not mutate the input records', () => {
  const polled = tx('deposit:d1', WALLET_A);
  const drained = tx('deposit:d1', null);
  mergeStrikeTransactions([polled], [drained], [WALLET_A]);
  assertEquals(drained.source_wallet_id, null, 'drain input untouched');
  assertEquals(polled.source_wallet_id, WALLET_A, 'poll input untouched');
});

Deno.test('merge: empty inputs produce an empty batch (no upsert)', () => {
  assert(mergeStrikeTransactions([], [], [WALLET_A]).length === 0);
});

// ── batchHttpStatus: response contract for issue #364 ───────────────

Deno.test('batchHttpStatus: empty results -> 200', () => {
  assertEquals(batchHttpStatus([]), 200);
});

Deno.test('batchHttpStatus: all succeeded -> 200', () => {
  assertEquals(batchHttpStatus([{ synced: 3 }, { synced: 1 }]), 200);
});

Deno.test('batchHttpStatus: mixed (some error) -> 207', () => {
  assertEquals(batchHttpStatus([{ synced: 5 }, { error: 'AUTH_FAILURE' }]), 207);
});

Deno.test('batchHttpStatus: all failed -> 422', () => {
  assertEquals(batchHttpStatus([{ error: 'AUTH_FAILURE' }, { error: 'RATE_LIMITED' }]), 422);
});

// ── throwOnDbError: connections update error-swallow guard (DL-0501) ────

Deno.test('throwOnDbError: throws the exact error object when present', () => {
  const err = { message: 'update failed: RLS violation', code: '42501' };
  let caught: unknown = undefined;
  try {
    throwOnDbError(err);
  } catch (e) {
    caught = e;
  }
  assertEquals(caught, err, 'must re-throw the exact DB error, not wrap it');
});

Deno.test('throwOnDbError: is a no-op when error is null or undefined', () => {
  // Neither call should throw; if they do, Deno.test fails the case.
  throwOnDbError(null);
  throwOnDbError(undefined);
});
