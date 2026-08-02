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
import { fetchPendingBatch, handleEvent, markDeferred } from './index.ts';

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
