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
