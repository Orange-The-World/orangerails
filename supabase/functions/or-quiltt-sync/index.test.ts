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
import { fetchPendingBatch, handleEvent, handleEventSinkDelivery, markDeferred, reconcileConnectionError, reDriveReadyDeferrals, upstreamCodeForErroredEvent } from './index.ts';

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
                { subaccount_id: 'sub-a', platform_id: null },
                { subaccount_id: 'sub-b', platform_id: null },
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
              data: [{ subaccount_id: 'sub-a', platform_id: null }, { subaccount_id: 'sub-b', platform_id: null }],
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

Deno.test('reDriveReadyDeferrals: re-drives sink platform subaccounts with no opk_public', async () => {
  // sub-sink is on plat-sink, a platform whose slug is in SINK_DELIVERY_PLATFORMS.
  // sub-sink has NO opk_public by design. Step-2 (OPK check) finds nothing; step-2b
  // (sink platform check) must surface it and include it in readyIds so step-3 clears
  // its opk_deferred_at. GUARD: the subaccount deliberately lacks opk_public -- a
  // test that passes because the subaccount has a key proves the OPK path, not the sink path.
  const updates: Array<{ patch: Record<string, unknown> }> = [];
  const step3Ids: string[] = [];
  let callSeq = 0;

  // deno-lint-ignore no-explicit-any
  const mockClient: any = {
    from(table: string) {
      callSeq++;
      const seq = callSeq;

      if (table === 'quiltt_webhook_inbox' && seq === 1) {
        return {
          select() { return this; },
          is()     { return this; },
          not()    { return this; },
          order()  { return this; },
          limit()  {
            return Promise.resolve({
              data: [{ subaccount_id: 'sub-sink', platform_id: 'plat-sink' }],
              error: null,
            });
          },
        };
      }

      if (table === 'subaccounts') {
        // sub-sink has no opk_public: step-2 returns empty, proving this test covers the sink path
        return {
          select() { return this; },
          in()     { return this; },
          not()    { return Promise.resolve({ data: [], error: null }); },
        };
      }

      if (table === 'platforms') {
        // step-2b: plat-sink slug is in SINK_DELIVERY_PLATFORMS
        let platInCalls = 0;
        // deno-lint-ignore no-explicit-any
        const platChain: any = {
          select() { return platChain; },
          in() {
            platInCalls++;
            return platInCalls === 2
              ? Promise.resolve({ data: [{ id: 'plat-sink' }], error: null })
              : platChain;
          },
        };
        return platChain;
      }

      if (table === 'quiltt_webhook_inbox' && seq === 4) {
        // step-3: clear opk_deferred_at for the sink subaccount
        // deno-lint-ignore no-explicit-any
        const ch: any = {
          update(patch: Record<string, unknown>, _opts: unknown) {
            updates.push({ patch });
            return ch;
          },
          in(_col: string, ids: string[]) {
            step3Ids.push(...ids);
            return ch;
          },
          is()  { return ch; },
          not() { return Promise.resolve({ count: 1, error: null }); },
        };
        return ch;
      }

      // deno-lint-ignore no-explicit-any
      return { select() { return this as any; }, is() { return this as any; }, not() { return Promise.resolve({ data: [], error: null }); } };
    },
  };

  const result = await reDriveReadyDeferrals(mockClient);
  assertEquals(result.reDriven, 1, 'reDriven must be 1: the sink event is cleared');
  assertEquals(result.error, null, 'error must be null');
  assertEquals(updates.length, 1, 'exactly one UPDATE must fire');
  assertEquals(
    updates[0].patch['opk_deferred_at'],
    null,
    'patch must null opk_deferred_at',
  );
  assertEquals(
    step3Ids.includes('sub-sink'),
    true,
    'step-3 IN filter must include sub-sink (sink subaccount with no opk_public)',
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
}): { client: any; inserted: string[]; cleanup: () => void } {
  const inserted: string[] = [];
  const client = {
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select(_c: string) { return chain; },
        eq(_c: string, _v: unknown) { return chain; },
        is(_c: string, _v: unknown) { return chain; },
        // The connections status reconcile ends in .in('status', [...]), and the
        // partial clear chains a second .eq(). Both must exist here or the call
        // is a TypeError inside handleEvent instead of a real assertion.
        in(_c: string, _v: unknown[]) { return chain; },
        not(_c: string, _op: string, _v: unknown) { return chain; },
        order(_c: string, _o: unknown) { return chain; },
        limit(_n: number) { return chain; },
        update(_patch: unknown, _opts?: unknown) { return chain; },
        single() {
          if (table === 'subaccounts') {
            return Promise.resolve({
              data: { id: 'sub-1', opk_public: opts.opkPublic ?? 'CQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', opk_alg: 'libsodium-crypto_box_seal-v1' },
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
          upsert(row: unknown, _opts: unknown) {
            const rows = Array.isArray(row)
              ? (row as Array<{ external_id: string }>)
              : [(row as { external_id: string })];
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
  const origFetch = (globalThis as any).fetch;
  // Patch global fetch for Quiltt GraphQL calls.
  // When source_wallets is empty the code does a GetAccounts pre-fetch (DL-0741)
  // before the transactions paging loop, so the mock must handle two distinct
  // query shapes. Distinguish by the request body: GetAccounts vs the Q transactions query.
  (globalThis as any).fetch = (_url: string, fetchOpts?: RequestInit) => {
    const body = typeof fetchOpts?.body === 'string' ? fetchOpts.body : '';
    if (body.includes('GetAccounts')) {
      // Accounts pre-fetch: return unique account ids derived from txNodes.
      const uniqueIds = [...new Set(
        opts.txNodes.map((tx) => tx.account?.id).filter((id): id is string => id != null),
      )];
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: { connection: { accounts: uniqueIds.map((id) => ({ id })) } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(
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
  };
  const cleanup = () => { (globalThis as any).fetch = origFetch; };
  return { client, inserted, cleanup };
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

// ── handleEventSinkDelivery: partial-index 23505 tolerance (DL-0853) ─
//
// Root cause of the Aug 2026 incident: connections.upsert({onConflict:
// 'subaccount_id,quiltt_connection_id'}) always fails against the partial unique
// index because PostgREST cannot express a partial-index predicate in the ON
// CONFLICT clause. The drain marked events as failed and retired them after
// MAX_ATTEMPTS, destroying customer bank data.
//
// The fix uses plain .insert() and treats error code 23505 (unique_violation) as
// success -- the row already exists from or-quiltt-link-complete, which is the
// normal path. These tests guard that path.
//
// Why a mock could not have caught the original bug: mock clients return success
// for .upsert() regardless, so a green test suite gave false confidence. The new
// tests assert the 23505-as-success path explicitly, so a future refactor that
// drops the `insertErr.code !== '23505'` check turns green into red.

Deno.test('handleEventSinkDelivery: 23505 on connections insert treated as success (partial-index tolerance)', async () => {
  let connectionsCallCount = 0;

  // deno-lint-ignore no-explicit-any
  const mockClient: any = {
    from(table: string) {
      if (table === 'connections') {
        connectionsCallCount++;
        if (connectionsCallCount === 1) {
          // First call: insert -- simulate the partial-index 23505 conflict that
          // killed events in production. PostgREST cannot express the partial predicate
          // in ON CONFLICT; the fix must silently treat this as "row already exists".
          return {
            insert(_row: unknown) {
              return Promise.resolve({
                data: null,
                error: {
                  code:    '23505',
                  message: 'duplicate key value violates unique constraint "connections_subaccount_id_quiltt_connection_id_idx"',
                },
              });
            },
          };
        }
        // Second call: select to resolve the connection row id after the conflict.
        // deno-lint-ignore no-explicit-any
        const chain: any = {
          select(_c: string) { return chain; },
          eq(_c: string, _v: unknown) { return chain; },
          maybeSingle() {
            return Promise.resolve({ data: { id: 'conn-or-1' }, error: null });
          },
        };
        return chain;
      }
      if (table === 'platforms') {
        // deno-lint-ignore no-explicit-any
        const ch: any = {
          select(_c: string) { return ch; },
          eq(_c: string, _v: unknown) { return ch; },
          maybeSingle() {
            // No webhook_url: skip the webhook enqueue branch.
            return Promise.resolve({ data: { webhook_url: null }, error: null });
          },
        };
        return ch;
      }
      // deno-lint-ignore no-explicit-any
      return { select() { return this as any; }, eq() { return this as any; } };
    },
  };

  const ev = {
    event_id:      'evt-sink-23505',
    event_type:    'connection.synced.successful.initial',
    payload:       { record: { id: 'quiltt-conn-1' } },
    platform_id:   'plat-sink',
    subaccount_id: 'sub-sink',
    attempts:      0,
  };

  const result = await handleEventSinkDelivery(mockClient, ev, 'quiltt-conn-1', 'plat-sink', 'sub-sink');
  assertEquals(
    result,
    'processed',
    '23505 from a partial unique index must be treated as success -- row already exists',
  );
});

Deno.test('handleEventSinkDelivery: non-23505 insert error surfaces as error string', async () => {
  // deno-lint-ignore no-explicit-any
  const mockClient: any = {
    from(table: string) {
      if (table === 'connections') {
        return {
          insert(_row: unknown) {
            return Promise.resolve({
              data: null,
              // Generic integrity error -- NOT a unique-violation. Must not be swallowed.
              error: { code: '23000', message: 'integrity constraint violation' },
            });
          },
        };
      }
      // deno-lint-ignore no-explicit-any
      return { select() { return this as any; }, eq() { return this as any; } };
    },
  };

  const ev = {
    event_id:      'evt-sink-dberr',
    event_type:    'connection.synced.successful.initial',
    payload:       { record: { id: 'quiltt-conn-2' } },
    platform_id:   'plat-sink',
    subaccount_id: 'sub-sink',
    attempts:      0,
  };

  const result = await handleEventSinkDelivery(mockClient, ev, 'quiltt-conn-2', 'plat-sink', 'sub-sink');
  assertEquals(
    typeof result === 'string' && result.includes('sink connection insert failed'),
    true,
    'a non-23505 insert error must surface as an error string, not be silently swallowed',
  );
});

// ── DL-0747 accounts query shape regression guard ─────────────────────────────
//
// Quiltt's Connection.accounts field returns [Account!] directly (a flat array).
// The correct query is `accounts { id }` and the unwrap is `accounts ?? []`.
// If the code reverts to `accounts { nodes { id } }` + `accounts?.nodes ?? []`,
// filterAccountIds will be [] (reading .nodes on a plain array gives undefined),
// the function returns 'connection has no accounts at Quiltt', and no transactions
// sync. This test fails in that case because inserted.length would be 0, not 2.

Deno.test('DL-0747 accounts shape: flat [Account] array (no nodes wrapper) -- ids extracted and transactions sync', async () => {
  // swRows = [] triggers the GetAccounts pre-fetch path.
  // The mock (updated above) returns accounts as a flat array -- correct Quiltt shape.
  // If code reads .nodes on a flat array, filterAccountIds is [], handleEvent
  // returns an error string, and inserted stays empty.
  const { client, inserted, cleanup } = makeQuilttSyncMock({
    swRows: [],
    txNodes: [
      { id: 'tx-dl0747-a', account: { id: 'acct-flat-1' } },
      { id: 'tx-dl0747-b', account: { id: 'acct-flat-2' } },
    ],
  });
  const ev = {
    event_id: 'evt-dl0747-shape',
    event_type: 'connection.synced.successful.initial',
    payload: { record: { id: 'qconn-dl0747' } },
    platform_id: 'plat-1',
    subaccount_id: 'sub-1',
    attempts: 0,
  };
  // deno-lint-ignore no-explicit-any
  await handleEvent(client as any, ev, 'plat-1', 'sub-1', 'api-key');
  assertEquals(
    inserted.length,
    2,
    'DL-0747: both transactions must sync; if 0, the code is reading .nodes on a plain array (regression)',
  );
  cleanup();
});

// ── DL-1445: a connection must never sit in 'error' with no recorded cause ──
//
// Two production connections were in exactly that state: status 'error',
// encrypted_last_error NULL. The cause was in scope the whole time as the
// event subtype, which the log line printed and then discarded.

Deno.test('DL-1445: errored subtypes map to the catalog, unknown subtypes still get a code', () => {
  assertEquals(
    upstreamCodeForErroredEvent('connection.synced.errored.repairable'),
    'UPSTREAM_AUTH_FAILED',
    'ERROR_REPAIRABLE can only be cleared by the user re-authenticating, which is what UPSTREAM_AUTH_FAILED tells them',
  );
  assertEquals(
    upstreamCodeForErroredEvent('connection.synced.errored.provider'),
    'UPSTREAM_UNAVAILABLE',
    'a provider-side failure is not the customer\'s to fix',
  );
  assertEquals(
    upstreamCodeForErroredEvent('connection.synced.errored.somethingNewQuilttAdds'),
    'UPSTREAM_OTHER',
    "Quiltt's errored taxonomy is not bounded: an unknown subtype must still record a cause rather than record nothing",
  );
});

function errorReconcileClient(sinkFormat: string | null) {
  const captured: { patch?: Record<string, unknown> } = {};
  // deno-lint-ignore no-explicit-any
  const client: any = {
    from(table: string) {
      if (table === 'platforms') {
        // deno-lint-ignore no-explicit-any
        const ch: any = {
          select(_c: string) { return ch; },
          eq(_c: string, _v: unknown) { return ch; },
          maybeSingle() { return Promise.resolve({ data: { sink_format: sinkFormat }, error: null }); },
        };
        return ch;
      }
      // connections
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select(_c: string) { return chain; },
        eq(_c: string, _v: unknown) { return chain; },
        is(_c: string, _v: unknown) { return chain; },
        order(_c: string, _o: unknown) { return chain; },
        limit(_n: number) { return chain; },
        maybeSingle() { return Promise.resolve({ data: { id: 'conn-or-1' }, error: null }); },
        update(patch: Record<string, unknown>) {
          captured.patch = patch;
          return { eq(_c: string, _v: unknown) { return Promise.resolve({ error: null }); } };
        },
      };
      return chain;
    },
  };
  return { client, captured };
}

const erroredEvent = {
  event_id:      'evt-dl1445',
  event_type:    'connection.synced.errored.repairable',
  payload:       { record: { id: 'quiltt-conn-1' } },
  platform_id:   'plat-sink',
  subaccount_id: 'sub-1',
  attempts:      0,
};

Deno.test('DL-1445: on a sink platform the cause is written alongside the error status', async () => {
  const { client, captured } = errorReconcileClient('bitbooks-v2');

  const err = await reconcileConnectionError(client, erroredEvent, 'sub-1');

  assertEquals(err, null, 'a clean reconcile returns null');
  assertEquals(captured.patch?.status, 'error', 'status must still be set to error');
  const stored = captured.patch?.encrypted_last_error as string | undefined;
  assertEquals(
    typeof stored === 'string' && stored.startsWith('UPSTREAM_AUTH_FAILED:'),
    true,
    'a connection must never enter error status with no cause recorded (DL-1445)',
  );
  assertEquals(
    (stored ?? '').split(':')[1]?.length,
    16,
    'the correlation id must be present so the failure can be cross-referenced in the edge logs',
  );
});

Deno.test('DL-1445: on a non-sink platform the column is left alone, never written in the clear', async () => {
  const { client, captured } = errorReconcileClient(null);

  const err = await reconcileConnectionError(client, erroredEvent, 'sub-1');

  assertEquals(err, null, 'a clean reconcile returns null');
  assertEquals(captured.patch?.status, 'error', 'status must still be set to error');
  assertEquals(
    'encrypted_last_error' in (captured.patch ?? {}),
    false,
    'this worker holds no transaction key, so on a non-sink platform it must not write a plaintext value a legacy client would try to decrypt',
  );
});
