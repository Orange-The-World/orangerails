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
import { mergeStrikeTransactions, batchHttpStatus, throwOnDbError, handleConnectionError, redactedUpstreamDetail } from './index.ts';
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

// ── Quiltt accountIds guard and GraphQL errors check (DL-0741) ────────
//
// The PR switches the Quiltt transaction filter from connectionId to
// accountIds. Two regressions are now possible:
//   1. Empty accountIds list -> accountIds: [] sent to the API, same
//      rejection shape as the original bug, just with a different arg.
//   2. GraphQL errors on the tx response silently drained as processed,
//      hiding failures the same way 95 rows were hidden originally.
//
// Source inspection, same rationale as the upstream-errors wiring tests:
// a unit test over an extracted pure helper cannot detect that the guard
// was removed from the live call site. These fail immediately if the
// guard disappears from either path.

const readSelf = (rel: string) =>
  Deno.readTextFileSync(new URL(rel, import.meta.url));

Deno.test('quiltt inbox drain (sink): empty-accountIds guard is present', () => {
  const src = readSelf('./index.ts');
  assertEquals(
    src.includes('filterAccountIdsSink.length === 0'),
    true,
    'sink path must short-circuit and stamp processed_at when account list is empty',
  );
});

Deno.test('quiltt inbox drain (legacy): empty-accountIds guard is present', () => {
  const src = readSelf('./index.ts');
  assertEquals(
    src.includes('filterAccountIdsMain.length === 0'),
    true,
    'legacy path must short-circuit and stamp processed_at when account list is empty',
  );
});

Deno.test('quiltt inbox drain: transactions response checked for GraphQL errors on both paths', () => {
  const src = readSelf('./index.ts');
  const sinkGuardIdx = src.indexOf('filterAccountIdsSink.length === 0');
  const legacyGuardIdx = src.indexOf('filterAccountIdsMain.length === 0');
  const allTxErrMatches = [...src.matchAll(/Quiltt transactions fetch errors/g)];
  assert(sinkGuardIdx !== -1, 'sink empty-account guard must be present');
  assert(legacyGuardIdx !== -1, 'legacy empty-account guard must be present');
  // At least two throws: one for sink path and one for legacy path.
  assert(
    allTxErrMatches.length >= 2,
    'transactions errors check must be present on both sink and legacy paths',
  );
  // The tx errors check must appear after each empty-account guard (proves it
  // is on the tx fetch response, not the accounts prefetch).
  const firstTxErrIdx = allTxErrMatches[0]?.index ?? -1;
  assert(
    firstTxErrIdx > sinkGuardIdx,
    'first transactions errors check must appear after the sink empty-account guard',
  );
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

// ── handleConnectionError: catch-body (DL-0501) ──────────────────────────────

Deno.test('handleConnectionError: classifies error, stamps status=error, returns structured result', async () => {
  // Fake client -- records what update() was called with; deliberately returns
  // a Supabase-style error object so the test verifies the catch body does not
  // re-throw on a failed status stamp and still returns the structured result.
  const updates: Record<string, unknown>[] = [];
  // deno-lint-ignore no-explicit-any
  const fakeClient: any = {
    from: (_table: string) => ({
      update: (data: Record<string, unknown>) => {
        updates.push(data);
        return {
          eq: (_col: string, _val: string) =>
            Promise.resolve({ error: { message: 'db write rejected', code: '42501' } }),
        };
      },
    }),
  };

  const conn = { id: 'conn-test-123' };
  // sinkMode=true: txnsKey is unused, no CryptoKey ceremony needed.
  const result = await handleConnectionError(
    fakeClient,
    conn,
    new Error('upstream auth failure'),
    { sinkMode: true, txnsKey: null },
  );

  // 1. Classifies: error field is a taxonomy code, not the raw upstream message.
  assert(typeof result.error === 'string' && result.error.length > 0, 'error must be a non-empty code');
  assert(!result.error.includes('auth failure'), 'raw upstream message must not appear in the error code');

  // 2. Stamps status='error' on the connection.
  assertEquals(updates[0]?.status, 'error');

  // 3. Structured result shape: all required fields present.
  assertEquals(result.connection_id, conn.id);
  assertEquals(result.next_cursor, null);
  assert(typeof result.correlation_id === 'string' && result.correlation_id.length > 0, 'correlation_id must be set');
  assert(typeof result.message === 'string', 'message field must be present');
  assert(typeof result.detail === 'string', 'detail field must be present');

  // 4. No re-throw: reaching this line proves handleConnectionError returned normally.
});

// ── Partial-miss guard: DL-1105 ──────────────────────────────────────────────
//
// When some but not all requested connection_ids resolve, the whole request
// must fail (non-2xx) rather than silently dropping the unresolved ids.
// Source-inspection tests verify the guard logic survives future edits to the
// handler, following the same pattern used for the quiltt accountIds guard above.

Deno.test('partial-miss guard (all-resolve path): boundary condition is correct', () => {
  // The guard uses Set-difference to compute unresolved ids: deduplicates the
  // requested list (avoiding false miss on duplicate ids), then filters out
  // resolved ids. Fires only when the result is non-empty. Both the dedup step
  // and the guard condition must survive future edits.
  const src = readSelf('./index.ts');
  assertEquals(
    src.includes('[...new Set(connection_ids)].filter'),
    true,
    'guard must deduplicate via Set to avoid false miss on duplicate ids',
  );
  assertEquals(
    src.includes('unresolvedIds.length > 0'),
    true,
    'guard must fire only when unresolved ids exist after set-difference',
  );
});

Deno.test('partial-miss guard (partial-resolve path): stealth_ids+unknown_ids in 400, unresolved_ids in 404', () => {
  const src = readSelf('./index.ts');
  assert(
    src.includes('stealth_ids: stealthIds'),
    'stealth-400 body must include stealth_ids field',
  );
  assert(
    src.includes('unknown_ids: unknownIds'),
    'stealth-400 body must include unknown_ids field',
  );
  assert(
    src.includes('unresolved_ids: unresolvedIds'),
    'unknown-404 body must include unresolved_ids field',
  );
});

Deno.test('partial-miss guard (partial-resolve path): stealth 400 and unknown 404 follow the guard', () => {
  const src = readSelf('./index.ts');
  const guardIdx = src.indexOf('unresolvedIds.length > 0');
  assert(guardIdx !== -1, 'partial-miss guard must be present in index.ts');
  const afterGuard = src.slice(guardIdx);
  assert(
    afterGuard.includes('Stealth connections cannot be synced via this endpoint'),
    '400 stealth branch must appear after the partial-miss guard',
  );
  assert(
    afterGuard.includes('Connection not found in this subaccount'),
    '404 unknown branch must appear after the partial-miss guard',
  );
});

Deno.test('partial-miss guard: mixed stealth+unknown -> 400 wins, both id sets listed separately', () => {
  // When unresolved ids include both stealth and genuinely unknown, 400 must win
  // (stealth is the caller-fixable condition). Both sets are listed in separate
  // fields so the caller can act on each independently.
  const src = readSelf('./index.ts');
  const guardIdx = src.indexOf('unresolvedIds.length > 0');
  assert(guardIdx !== -1, 'partial-miss guard must be present');
  const afterGuard = src.slice(guardIdx);
  // 400 branch fires when ANY stealth id is present (covers the mixed case).
  assert(
    afterGuard.includes('stealthRows.length > 0'),
    'stealth branch must fire on any stealthRows presence, covering the mixed case',
  );
  // unknownIds computed as set-difference so genuinely unknown ids are not lost.
  assert(
    afterGuard.includes('unresolvedIds.filter((id) => !stealthSet.has(id))'),
    'unknown_ids must be the diff of unresolvedIds minus the stealth set',
  );
  // Both fields present in the 400 body.
  assert(
    afterGuard.includes('stealth_ids: stealthIds'),
    '400 body must carry stealth_ids',
  );
  assert(
    afterGuard.includes('unknown_ids: unknownIds'),
    '400 body must carry unknown_ids (empty when all unresolved are stealth)',
  );
});

Deno.test('total-miss guard: all-disconnected ids return 422 not 404', () => {
  // When every requested id resolves to a disconnected connection (excluded by
  // the main query's neq status=disconnected), returning 404 misleads callers:
  // the id exists, it is just disconnected. 422 matches the partial-miss path.
  // Verify the disconnected check appears before the first total-miss 404 in source.
  const src = readSelf('./index.ts');
  // indexOf returns the FIRST occurrence -- that is the total-miss branch, which
  // appears before the partial-miss branch in the file.
  const totalMiss404Idx = src.indexOf("'Connection not found in this subaccount'");
  assert(totalMiss404Idx !== -1, 'total-miss 404 message must be present');
  const disconnectedCheckIdx = src.indexOf("'Connection is disconnected and cannot be synced'");
  assert(disconnectedCheckIdx !== -1, 'disconnected 422 message must be present');
  assert(
    disconnectedCheckIdx < totalMiss404Idx,
    'disconnected 422 check must appear before the total-miss 404 fallback',
  );
});

// ──────────────────────────────────────────────────────────────────────────────
// DL-1440: external_wallet_id collision across customers
//
// DBA confirmed 2026-08-19: 5 external_wallet_id values repeat across different
// customers' connections in prod (33 affected source_wallets rows). Providers
// including Blink and ccxt emit non-globally-unique wallet identifiers. Storing
// a bare provider id in encrypted_transactions.source_wallet_id means any lookup
// by that column alone resolves ambiguously.
//
// The fix (in or-sync): build a map of external_wallet_id -> source_wallets.id
// (internal UUID) and rewrite each transaction's source_wallet_id to the UUID
// before persisting. These tests pin that behaviour.
// ──────────────────────────────────────────────────────────────────────────────

Deno.test('DL-1440: remap resolves colliding external ids to distinct internal UUIDs', () => {
  // Two customers both connect to Blink. Blink returns the same wallet id for
  // each of their BTC wallets (e.g. a slug or short opaque id that is not
  // globally unique across Blink accounts -- DBA confirmed this scenario).
  const BLINK_BTC_WALLET_ID = 'blink-btc-wallet-x';

  // Customer A's connection row
  const connA_id = '00000000-0000-0000-0000-000000000001';
  const connA_internalId = '00000000-0000-0000-1111-000000000001'; // source_wallets.id for A

  // Customer B's connection row (same external id, different connection)
  const connB_id = '00000000-0000-0000-0000-000000000002';
  const connB_internalId = '00000000-0000-0000-1111-000000000002'; // source_wallets.id for B

  // Simulate externalToInternalId map for customer A's sync run
  const externalToInternalId = new Map<string, string>([
    [BLINK_BTC_WALLET_ID, connA_internalId],
  ]);

  // A transaction comes back from the Blink adapter tagged with the provider id
  const rawTx = {
    id: 'tx-001',
    source_wallet_id: BLINK_BTC_WALLET_ID,
  };

  // Apply the DL-1440 remap (mirrors the logic in or-sync/index.ts)
  const remapped = {
    ...rawTx,
    source_wallet_id: rawTx.source_wallet_id != null
      ? (externalToInternalId.get(rawTx.source_wallet_id) ?? null)
      : null,
  };

  // The persisted source_wallet_id must be the INTERNAL UUID for A, not the
  // bare provider id. If it were the provider id, a lookup by that id alone
  // could match customer B's wallet row (connB_internalId) too.
  assertEquals(
    remapped.source_wallet_id,
    connA_internalId,
    'source_wallet_id must be the internal UUID, not the provider-issued external id',
  );
  assert(
    remapped.source_wallet_id !== BLINK_BTC_WALLET_ID,
    'source_wallet_id must not be the raw provider wallet id after remap',
  );
  assert(
    remapped.source_wallet_id !== connB_internalId,
    'remap must not produce customer B uuid when running in customer A context',
  );

  // Customer B's sync run builds a different map (different connection) and
  // gets its own distinct internal UUID. Same external id -> different UUID.
  const externalToInternalIdB = new Map<string, string>([
    [BLINK_BTC_WALLET_ID, connB_internalId],
  ]);
  const remappedB = {
    ...rawTx,
    source_wallet_id: rawTx.source_wallet_id != null
      ? (externalToInternalIdB.get(rawTx.source_wallet_id) ?? null)
      : null,
  };
  assertEquals(remappedB.source_wallet_id, connB_internalId);
  assert(remappedB.source_wallet_id !== connA_internalId, 'B uuid must differ from A uuid');
  assert(
    remapped.source_wallet_id !== remappedB.source_wallet_id,
    'same provider wallet id must resolve to distinct internal UUIDs per connection',
  );
});

Deno.test('DL-1440: remap sets source_wallet_id null when no map entry (syncAccountWide path)', () => {
  // When a provider emits source_wallet_id but there are no source_wallets rows
  // (syncAccountWide fallback, no wallet selection configured), the map is empty
  // and the id should become null rather than leaking the provider id.
  const externalToInternalId = new Map<string, string>();
  const rawTx = { id: 'tx-002', source_wallet_id: 'coinbase' };
  const remapped = {
    ...rawTx,
    source_wallet_id: rawTx.source_wallet_id != null
      ? (externalToInternalId.get(rawTx.source_wallet_id) ?? null)
      : null,
  };
  assertEquals(remapped.source_wallet_id, null, 'unmapped provider id must become null');
});

Deno.test('DL-1440: remap preserves null source_wallet_id unchanged', () => {
  const externalToInternalId = new Map<string, string>([['x', 'y']]);
  const rawTx = { id: 'tx-003', source_wallet_id: null as string | null };
  const remapped = {
    ...rawTx,
    source_wallet_id: rawTx.source_wallet_id != null
      ? (externalToInternalId.get(rawTx.source_wallet_id) ?? null)
      : null,
  };
  assertEquals(remapped.source_wallet_id, null, 'null input must stay null after remap');
});

Deno.test('DL-1440: or-sync source code must select id from source_wallets (DL-1440 guard)', () => {
  // Pin that or-sync fetches source_wallets.id (needed to build externalToInternalId).
  // If this reverts to selecting only external_wallet_id, the remap map would
  // have no internal UUIDs to emit and would always produce null.
  const src = readSelf('./index.ts');
  assert(
    src.includes("'id, external_wallet_id, is_synced, wallet_fingerprint'"),
    'source_wallets select must include id field (DL-1440 composite anchor)',
  );
});

Deno.test('DL-1440: or-sync source code must contain externalToInternalId remap (DL-1440 guard)', () => {
  const src = readSelf('./index.ts');
  assert(
    src.includes('externalToInternalId'),
    'or-sync must build externalToInternalId map (DL-1440 fix)',
  );
  assert(
    src.includes('externalToInternalId.get(tx.source_wallet_id)'),
    'or-sync must remap tx.source_wallet_id via externalToInternalId (DL-1440 fix)',
  );
});

// ── DL-1433: redactedUpstreamDetail strips emails and 4-digit refs ────────────

Deno.test('DL-1433: redactedUpstreamDetail strips email addresses before log', () => {
  const out = redactedUpstreamDetail('Failed auth for user test@example.com in provider');
  assert(!out.includes('@'), 'email must not appear in redacted output');
  assert(!out.includes('test@example.com'), 'full email address must be absent');
  assertEquals(out.includes('<email>'), true, 'email placeholder must be present');
});

Deno.test('DL-1433: redactedUpstreamDetail strips 4-digit numeric account refs before log', () => {
  const out = redactedUpstreamDetail('Account 1234 rejected by upstream');
  assert(!out.includes('1234'), '4-digit ref must not appear in redacted output');
  assertEquals(out.includes('[redacted]'), true, 'numeric placeholder must be present');
});

Deno.test('DL-1433: redactedUpstreamDetail strips partial numeric refs (card-ending) before log', () => {
  const out = redactedUpstreamDetail('Card ending 5678 was declined by issuer');
  assert(!out.includes('5678'), 'partial numeric ref must not appear in redacted output');
  assertEquals(out.includes('[redacted]'), true, 'numeric placeholder must be present');
});

// ── OR-T1249: sinkMode must not treat the 'none' sentinel as a format ────────
//
// resolveSinkFormatForPlatform already maps a stored 'none' to null before it
// reaches `format`, so this line should never actually see the string 'none'
// today. The exclusion here is belt-and-suspenders (OR-T1249's explicit ask):
// it keeps this call site correct even if a future caller reaches it with
// 'none' through some other path. Source-inspection, same rationale as the
// other guards in this file: sinkMode is computed inline in the handler, not
// exported, so a unit test over an extracted helper could not see it drift.

Deno.test('OR-T1249: sinkMode computation excludes the none sentinel', () => {
  const src = readSelf('./index.ts');
  assertEquals(
    src.includes("format.length > 0 && format !== 'none'"),
    true,
    'sinkMode must not enter sink mode for the explicit no-sink sentinel',
  );
});
