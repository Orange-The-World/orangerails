/**
 * Tests for or-quiltt-sync.
 *
 * Run with:
 *   deno test supabase/functions/or-quiltt-sync/index.test.ts
 *
 * Covers:
 *   - fetchPendingBatch filters processed_at IS NULL AND opk_deferred_at IS NULL.
 *     This test fails if the opk_deferred_at filter is removed (Auditor req 2).
 *   - handleEvent returns 'deferred' when subaccount.opk_public is null.
 *   - markDeferred writes opk_deferred_at, not processed_at.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { fetchPendingBatch, handleEvent, markDeferred, reDriveReadyDeferrals } from './index.ts';

// ── fetchPendingBatch: batch query filter ─────────────────────────────
//
// This test is the regression guard for Auditor requirement 2.
// If .is('opk_deferred_at', null) is removed from fetchPendingBatch,
// this test fails because the collected isFilters will not contain
// the opk_deferred_at entry.

Deno.test('fetchPendingBatch: filters processed_at AND opk_deferred_at as null', async () => {
  const isFilters: Array<[string, unknown]> = [];

  const mockClient = {
    from(_table: string) {
      const chain = {
        select(_cols: string) { return chain; },
        is(col: string, val: unknown) {
          isFilters.push([col, val]);
          return chain;
        },
        order(_col: string, _opts: unknown) { return chain; },
        limit(_n: number) {
          return Promise.resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  };

  // deno-lint-ignore no-explicit-any
  await fetchPendingBatch(mockClient as any, 20);

  const filtered = new Map(isFilters);
  assertEquals(filtered.get('processed_at'), null, 'must filter processed_at IS NULL');
  assertEquals(
    filtered.get('opk_deferred_at'),
    null,
    'must filter opk_deferred_at IS NULL -- remove this and deferred rows starve the queue',
  );
});

// ── handleEvent: deferred return when opk_public is null ─────────────

Deno.test('handleEvent: returns deferred when subaccount has no opk_public', async () => {
  const mockClient = {
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select(_cols: string) { return chain; },
        eq(_col: string, _val: unknown) { return chain; },
        is(_col: string, _val: unknown) { return chain; },
        order(_col: string, _opts: unknown) { return chain; },
        limit(_n: number) { return chain; },
        single() {
          if (table === 'subaccounts') {
            return Promise.resolve({
              data: { id: 'sub-1', opk_public: null, opk_alg: null },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: { message: 'unexpected table' } });
        },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      };
      return chain;
    },
  };

  const ev = {
    event_id:      'evt-1',
    event_type:    'connection.synced.successful.initial',
    payload:       { record: { id: 'conn-abc' } },
    platform_id:   'plat-1',
    subaccount_id: 'sub-1',
    attempts:      0,
  };

  // deno-lint-ignore no-explicit-any
  const result = await handleEvent(mockClient as any, ev, 'plat-1', 'sub-1', 'api-key');
  assertEquals(result, 'deferred', 'handleEvent must return deferred when opk_public is null');
});

// ── handleEvent: errored event dispatches to reconcileConnectionError ─
//
// Regression guard for the startsWith('connection.synced.errored') block
// at handleEvent lines 217-220 (DL-0441). Without those lines the event
// falls through to the successful-only guard and returns 'skipped', failing
// this test. handleEvent returns 'processed' explicitly after
// reconcileConnectionError returns null (its success in the string|null
// contract), so the assertion targets handleEvent's return, not the helper.

Deno.test('handleEvent: dispatches errored event, reconciles connection to error, returns processed', async () => {
  let updateCalled = false;

  const mockClient = {
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select() { return chain; },
        eq()     { return chain; },
        is()     { return chain; },
        order()  { return chain; },
        limit()  { return chain; },
        update(_patch: unknown) {
          if (table === 'connections') updateCalled = true;
          return chain;
        },
        single() {
          if (table === 'subaccounts') {
            return Promise.resolve({
              data: { id: 'sub-1', opk_public: 'pk-abc', opk_alg: 'ed25519' },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        maybeSingle() {
          if (table === 'connections') {
            return Promise.resolve({ data: { id: 'conn-or-1' }, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return chain;
    },
  };

  const ev = {
    event_id:      'evt-err-1',
    event_type:    'connection.synced.errored.repairable',
    payload:       { record: { id: 'quiltt-conn-1' } },
    platform_id:   'plat-1',
    subaccount_id: 'sub-1',
    attempts:      0,
  };

  // deno-lint-ignore no-explicit-any
  const result = await handleEvent(mockClient as any, ev, 'plat-1', 'sub-1', 'api-key');
  assertEquals(result, 'processed', 'errored event must return processed after status flip');
  assertEquals(updateCalled, true, 'must call update on connections table to flip status to error');
});

// ── reDriveReadyDeferrals ─────────────────────────────────────────────
//
// Guards for the three-step sweep that re-admits OPK-deferred rows
// whose subaccount has since registered a public key (DL-0643).

Deno.test('reDriveReadyDeferrals: returns { reDriven: 0 } when no deferred rows exist', async () => {
  // Step 1 returns empty list -- function must short-circuit without
  // querying subaccounts or touching inbox rows.
  let subaccountsQueried = false;
  let updateCalled       = false;

  const mockClient = {
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select()  { return chain; },
        is()      { return chain; },
        not()     { return chain; },
        in()      {
          if (table === 'subaccounts') subaccountsQueried = true;
          return chain;
        },
        update()  { updateCalled = true; return chain; },
      };
      // step-1 promise: empty rows
      chain.then = (resolve: (v: unknown) => void) =>
        resolve({ data: [], error: null });
      // make it thenable so await works
      Object.defineProperty(chain, Symbol.toStringTag, { value: 'MockChain' });
      return {
        select()  { return chain; },
        from()    { return chain; },
      };
    },
  };

  // Build a simpler mock: step-1 promise returns empty.
  const simpleMock = {
    from(_table: string) {
      return {
        select() { return this; },
        is()     { return this; },
        not()    { return this; },
        order()  { return this; },
        limit()  {
          return Promise.resolve({ data: [], error: null });
        },
        in() {
          subaccountsQueried = true;
          return this;
        },
        update() {
          updateCalled = true;
          return this;
        },
      };
    },
  };

  // deno-lint-ignore no-explicit-any
  const result = await reDriveReadyDeferrals(simpleMock as any);
  assertEquals(result.reDriven, 0, 'reDriven must be 0 when inbox has no deferred rows');
  assertEquals(result.error, null, 'error must be null (clean early exit)');
  assertEquals(subaccountsQueried, false, 'must not query subaccounts when there are no deferred rows');
  assertEquals(updateCalled, false, 'must not call update when there are no deferred rows');
});

Deno.test('reDriveReadyDeferrals: returns { reDriven: 0 } when no deferred subaccount has an OPK', async () => {
  // Step 1 returns two deferred rows; step 2 returns empty (no OPK).
  // Must not touch inbox rows.
  let updateCalled = false;
  let callCount    = 0;

  const mockClient = {
    from(table: string) {
      callCount++;
      const call = callCount;
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select() { return chain; },
        is()     { return chain; },
        not()    { return chain; },
        in()     { return chain; },
        update() { updateCalled = true; return chain; },
      };
      if (table === 'quiltt_webhook_inbox' && call === 1) {
        // step-1: return two deferred rows
        return {
          select() { return this; },
          is()     { return this; },
          not()    { return this; },
          order()  { return this; },
          limit()  {
            return Promise.resolve({
              data: [
                { subaccount_id: 'sub-a' },
                { subaccount_id: 'sub-b' },
              ],
              error: null,
            });
          },
        };
      }
      if (table === 'subaccounts') {
        // step-2: no OPK on any subaccount
        return {
          select() { return this; },
          in()     { return this; },
          not()    {
            return Promise.resolve({ data: [], error: null });
          },
          update() { updateCalled = true; return this; },
        };
      }
      // unexpected table
      return chain;
    },
  };

  // deno-lint-ignore no-explicit-any
  const result = await reDriveReadyDeferrals(mockClient as any);
  assertEquals(result.reDriven, 0, 'reDriven must be 0 when no subaccount has OPK');
  assertEquals(result.error, null, 'error must be null');
  assertEquals(updateCalled, false, 'must not call update when no subaccount has OPK');
});

Deno.test('reDriveReadyDeferrals: clears opk_deferred_at for OPK-ready subaccounts and returns count', async () => {
  // Sub-a has OPK; sub-b does not. Sweep must clear only sub-a rows.
  const updates: Array<{ patch: Record<string, unknown> }> = [];
  let inFilter: string[] = [];
  let callSeq = 0;

  const mockClient = {
    from(table: string) {
      callSeq++;
      const seq = callSeq;

      if (table === 'quiltt_webhook_inbox' && seq === 1) {
        // step-1: two deferred rows
        return {
          select() { return this; },
          is()     { return this; },
          not()    { return this; },
          order()  { return this; },
          limit()  {
            return Promise.resolve({
              data: [{ subaccount_id: 'sub-a' }, { subaccount_id: 'sub-b' }],
              error: null,
            });
          },
        };
      }
      if (table === 'subaccounts') {
        // step-2: only sub-a has OPK
        return {
          select() { return this; },
          // deno-lint-ignore no-explicit-any
          in(_col: string, ids: any[]) {
            inFilter = ids;
            return this;
          },
          not()    {
            return Promise.resolve({ data: [{ id: 'sub-a' }], error: null });
          },
        };
      }
      if (table === 'quiltt_webhook_inbox' && seq === 3) {
        // step-3: clear
        // deno-lint-ignore no-explicit-any
        const chain: any = {
          update(patch: Record<string, unknown>, _opts: unknown) {
            updates.push({ patch });
            return chain;
          },
          in()  { return chain; },
          is()  { return chain; },
          not() {
            return Promise.resolve({ count: 4, error: null });
          },
        };
        return chain;
      }
      return { select() { return this; }, is() { return this; }, not() { return Promise.resolve({ data: [], error: null }); } };
    },
  };

  // deno-lint-ignore no-explicit-any
  const result = await reDriveReadyDeferrals(mockClient as any);
  assertEquals(result.reDriven, 4, 'reDriven must equal the count returned by the UPDATE');
  assertEquals(result.error, null, 'error must be null on success');
  assertEquals(updates.length, 1, 'exactly one UPDATE must fire');
  assertEquals(
    updates[0].patch['opk_deferred_at'],
    null,
    'patch must null opk_deferred_at',
  );
  assertEquals(
    inFilter.includes('sub-a'),
    true,
    'subaccounts IN filter must include sub-a',
  );
  assertEquals(
    inFilter.includes('sub-b'),
    true,
    'subaccounts IN filter must include sub-b (to let the DB filter by OPK)',
  );
});

Deno.test('reDriveReadyDeferrals: returns error string when first query fails, does not throw', async () => {
  const mockClient = {
    from(_table: string) {
      return {
        select() { return this; },
        is()     { return this; },
        not()    { return this; },
        order()  { return this; },
        limit()  {
          return Promise.resolve({ data: null, error: { message: 'connection timeout' } });
        },
      };
    },
  };

  // deno-lint-ignore no-explicit-any
  const result = await reDriveReadyDeferrals(mockClient as any);
  assertEquals(result.reDriven, 0, 'reDriven must be 0 on first-query failure');
  assertEquals(
    typeof result.error === 'string' && result.error.includes('connection timeout'),
    true,
    'error must surface the DB error message',
  );
});

// ── DL-0442 account selection filter: four unit paths ─────────────────
//
// These tests instrument handleEvent with a mock that controls what
// source_wallets rows are returned and what Quiltt GraphQL returns.
// They verify the four cases the Auditor flagged as untested:
//   1. Subset selected: only is_synced=true accounts' transactions land.
//   2. None selected (all is_synced=false): zero transactions land.
//   3. No source_wallets rows: all-sync fallback (no filtering).
//   4. DB error on source_wallets lookup: handleEvent errors, not all-sync.

function makeQuilttSyncMock(opts: {
  swRows: Array<{ external_wallet_id: string; is_synced: boolean }> | null;
  swError?: string;
  txNodes: Array<{ id: string; account: { id: string } | null }>;
  opkPublic?: string;
}): { client: any; inserted: string[] } {
  const inserted: string[] = [];
  const client = {
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select(_c: string) { return chain; },
        eq(_c: string, _v: unknown) { return chain; },
        is(_c: string, _v: unknown) { return chain; },
        order(_c: string, _o: unknown) { return chain; },
        limit(_n: number) { return chain; },
        single() {
          if (table === 'subaccounts') {
            return Promise.resolve({
              data: { id: 'sub-1', opk_public: opts.opkPublic ?? 'fakepub', opk_alg: 'x25519' },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: { message: 'unexpected' } });
        },
        maybeSingle() {
          if (table === 'connections') {
            return Promise.resolve({ data: { id: 'conn-1' }, error: null });
          }
          if (table === 'quiltt_profile_map') {
            return Promise.resolve({ data: { quiltt_profile_id: 'qp-1' }, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        upsert(_rows: unknown[], _opts: unknown) {
          return Promise.resolve({ data: null, error: null });
        },
      };
      if (table === 'source_wallets') {
        return {
          select(_c: string) { return this; },
          eq(_c: string, _v: unknown) {
            return Promise.resolve(
              opts.swError
                ? { data: null, error: { message: opts.swError } }
                : { data: opts.swRows ?? [], error: null },
            );
          },
        };
      }
      if (table === 'encrypted_transactions') {
        return {
          upsert(rows: Array<{ external_id: string }>, _opts: unknown) {
            for (const r of rows) inserted.push(r.external_id);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      return chain;
    },
    rpc(_name: string) {
      return Promise.resolve({ data: 'stubtoken', error: null });
    },
  };
  // Patch global fetch for the Quiltt GraphQL call.
  (globalThis as any).__quilttFetchStub = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: {
            transactions: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: opts.txNodes.map((tx) => ({
                id:          tx.id,
                amount:      '10.00',
                currencyCode: 'USD',
                date:        '2026-01-01',
                description: 'stub',
                entryType:   'debit',
                status:      'posted',
                account:     tx.account,
              })),
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  return { client, inserted };
}

Deno.test('DL-0442 account filter: subset selected -- only matching accounts sync', async () => {
  const { client, inserted } = makeQuilttSyncMock({
    swRows: [
      { external_wallet_id: 'acct-A', is_synced: true },
      { external_wallet_id: 'acct-B', is_synced: false },
    ],
    txNodes: [
      { id: 'tx-1', account: { id: 'acct-A' } },
      { id: 'tx-2', account: { id: 'acct-B' } },
      { id: 'tx-3', account: { id: 'acct-C' } },
    ],
  });
  const ev = {
    event_id: 'evt-sel', event_type: 'connection.synced.successful.initial',
    payload: { record: { id: 'qconn-1' } }, platform_id: 'plat-1', subaccount_id: 'sub-1', attempts: 0,
  };
  // deno-lint-ignore no-explicit-any
  const result = await handleEvent(client as any, ev, 'plat-1', 'sub-1', 'api-key');
  assertEquals(typeof result, 'string', 'handleEvent must return a string result');
  assertEquals(inserted.length, 1, 'only the is_synced=true account transaction must be inserted');
  assertEquals(inserted[0], 'tx-1', 'tx-1 (acct-A, is_synced=true) must land');
});

Deno.test('DL-0442 account filter: none selected (all is_synced=false) -- zero transactions sync', async () => {
  const { client, inserted } = makeQuilttSyncMock({
    swRows: [
      { external_wallet_id: 'acct-A', is_synced: false },
      { external_wallet_id: 'acct-B', is_synced: false },
    ],
    txNodes: [
      { id: 'tx-1', account: { id: 'acct-A' } },
      { id: 'tx-2', account: { id: 'acct-B' } },
    ],
  });
  const ev = {
    event_id: 'evt-none', event_type: 'connection.synced.successful.initial',
    payload: { record: { id: 'qconn-1' } }, platform_id: 'plat-1', subaccount_id: 'sub-1', attempts: 0,
  };
  // deno-lint-ignore no-explicit-any
  await handleEvent(client as any, ev, 'plat-1', 'sub-1', 'api-key');
  assertEquals(inserted.length, 0, 'no transactions must sync when all accounts are deselected');
});

Deno.test('DL-0442 account filter: no source_wallets rows -- all-sync fallback', async () => {
  const { client, inserted } = makeQuilttSyncMock({
    swRows: [],
    txNodes: [
      { id: 'tx-1', account: { id: 'acct-A' } },
      { id: 'tx-2', account: { id: 'acct-B' } },
    ],
  });
  const ev = {
    event_id: 'evt-allsync', event_type: 'connection.synced.successful.initial',
    payload: { record: { id: 'qconn-1' } }, platform_id: 'plat-1', subaccount_id: 'sub-1', attempts: 0,
  };
  // deno-lint-ignore no-explicit-any
  await handleEvent(client as any, ev, 'plat-1', 'sub-1', 'api-key');
  assertEquals(inserted.length, 2, 'all transactions must sync when no source_wallets rows exist');
});

Deno.test('DL-0442 account filter: source_wallets DB error -- handleEvent errors, not all-sync', async () => {
  const { client, inserted } = makeQuilttSyncMock({
    swRows: null,
    swError: 'connection timeout',
    txNodes: [
      { id: 'tx-1', account: { id: 'acct-A' } },
    ],
  });
  const ev = {
    event_id: 'evt-dberr', event_type: 'connection.synced.successful.initial',
    payload: { record: { id: 'qconn-1' } }, platform_id: 'plat-1', subaccount_id: 'sub-1', attempts: 0,
  };
  // deno-lint-ignore no-explicit-any
  const result = await handleEvent(client as any, ev, 'plat-1', 'sub-1', 'api-key');
  assertEquals(
    typeof result === 'string' && result.includes('source_wallets lookup failed'),
    true,
    'handleEvent must return an error string when source_wallets lookup fails',
  );
  assertEquals(inserted.length, 0, 'no transactions must sync when the DB lookup fails');
});

// ── markDeferred: stamps opk_deferred_at, not processed_at ───────────

Deno.test('markDeferred: updates opk_deferred_at field on the correct row', async () => {
  const updates: Array<{ patch: Record<string, unknown>; id: string }> = [];

  const mockClient = {
    from(_table: string) {
      let pendingPatch: Record<string, unknown> | null = null;
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        update(patch: Record<string, unknown>) {
          pendingPatch = patch;
          return chain;
        },
        eq(_col: string, val: string) {
          if (pendingPatch) {
            updates.push({ patch: pendingPatch, id: val });
            pendingPatch = null;
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return chain;
    },
  };

  // deno-lint-ignore no-explicit-any
  await markDeferred(mockClient as any, 'evt-xyz');

  assertEquals(updates.length, 1, 'exactly one update must fire');
  assertEquals(updates[0].id, 'evt-xyz', 'update must target the correct event_id');
  assertEquals(
    'opk_deferred_at' in updates[0].patch,
    true,
    'patch must contain opk_deferred_at',
  );
  assertEquals(
    'processed_at' in updates[0].patch,
    false,
    'markDeferred must not touch processed_at',
  );
});
