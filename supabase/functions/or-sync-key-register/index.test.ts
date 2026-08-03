/**
 * Tests for or-sync-key-register.
 *
 * Run with:
 *   deno test supabase/functions/or-sync-key-register/index.test.ts
 *
 * Covers:
 *   - clearDeferredRows patches opk_deferred_at to null on the right subaccount.
 *     Fails if the column name or the subaccount_id filter changes.
 *   - clearDeferredRows returns the updated row count from the DB.
 *   - clearDeferredRows returns an error string (never throws) when the update fails.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { clearDeferredRows } from './index.ts';

// ── clearDeferredRows: correct patch and filter ───────────────────────
//
// This test is the regression guard for DL-0482.
// If opk_deferred_at is renamed, or the subaccount_id eq-filter is dropped,
// this test fails before any deferred rows are mis-cleared or left stuck.

Deno.test('clearDeferredRows: patches opk_deferred_at to null scoped to subaccount', async () => {
  let capturedPatch: Record<string, unknown> | null = null;
  const capturedEq: Array<[string, unknown]> = [];
  const capturedNot: Array<[string, string, unknown]> = [];

  const mockClient = {
    from(_table: string) {
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        update(patch: Record<string, unknown>, _opts: unknown) {
          capturedPatch = patch;
          return chain;
        },
        eq(col: string, val: unknown) {
          capturedEq.push([col, val]);
          return chain;
        },
        not(col: string, op: string, val: unknown) {
          capturedNot.push([col, op, val]);
          return Promise.resolve({ count: 5, error: null });
        },
      };
      return chain;
    },
  };

  // deno-lint-ignore no-explicit-any
  const result = await clearDeferredRows(mockClient as any, 'sub-abc');

  assertEquals(
    capturedPatch,
    { opk_deferred_at: null },
    'must null the opk_deferred_at column',
  );

  const eqFilter = capturedEq.find(([col]) => col === 'subaccount_id');
  assertEquals(eqFilter?.[1], 'sub-abc', 'must scope update to the given subaccount_id');

  assertEquals(
    capturedNot[0]?.[0],
    'opk_deferred_at',
    'not() filter must target opk_deferred_at',
  );
  assertEquals(
    capturedNot[0]?.[1],
    'is',
    'not() operator must be "is" (IS NOT NULL semantics)',
  );

  assertEquals(result.count, 5, 'must return the updated row count');
  assertEquals(result.error, null, 'must return null error on success');
});

// ── clearDeferredRows: surfaces errors without throwing ───────────────

Deno.test('clearDeferredRows: returns error string when update fails, count is 0', async () => {
  const mockClient = {
    from(_table: string) {
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        update(_patch: unknown, _opts: unknown) { return chain; },
        eq(_col: string, _val: unknown) { return chain; },
        not(_col: string, _op: string, _val: unknown) {
          return Promise.resolve({ count: null, error: { message: 'db write failed' } });
        },
      };
      return chain;
    },
  };

  // deno-lint-ignore no-explicit-any
  const result = await clearDeferredRows(mockClient as any, 'sub-xyz');

  assertEquals(result.count, 0, 'count must be 0 when the update errors');
  assertEquals(result.error, 'db write failed', 'error message must be surfaced');
});

// ── clearDeferredRows: zero rows is a valid no-op ─────────────────────

Deno.test('clearDeferredRows: returns count 0 when no deferred rows exist', async () => {
  const mockClient = {
    from(_table: string) {
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        update(_patch: unknown, _opts: unknown) { return chain; },
        eq(_col: string, _val: unknown) { return chain; },
        not(_col: string, _op: string, _val: unknown) {
          return Promise.resolve({ count: 0, error: null });
        },
      };
      return chain;
    },
  };

  // deno-lint-ignore no-explicit-any
  const result = await clearDeferredRows(mockClient as any, 'sub-no-deferred');

  assertEquals(result.count, 0, 'count must be 0 when no rows matched');
  assertEquals(result.error, null, 'must be null error');
});
