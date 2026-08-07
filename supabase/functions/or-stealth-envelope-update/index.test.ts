/**
 * Unit tests for or-stealth-envelope-update cursor logic (DL-0529).
 *
 * Run with:
 *   deno test supabase/functions/or-stealth-envelope-update/index.test.ts
 *
 * Tests the exported advanceCursor helper in isolation. HTTP-surface coverage
 * comes from integration probes after deploy.
 *
 * Three cases per DL-0529 acceptance criteria:
 *   1. Forward advance: incoming > stored, UPDATE fires, returns incoming tip.
 *   2. Forward-only guard no-op: incoming <= stored, UPDATE is a no-op,
 *      returns stored cursor via fresh re-read.
 *   3. Concurrent no-op: concurrent caller already advanced past incoming,
 *      UPDATE is a no-op, fresh re-read returns the concurrent max.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { advanceCursor, isAdvanceCursorError } from './cursor.ts';

const PLATFORM_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CONN_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/**
 * Minimal thenable-chain mock. The first maybeSingle() call is the UPDATE
 * (returns updateResult); the second is the no-op path fresh re-read
 * (returns freshRow). Forward-advance tests never reach the second call.
 */
// deno-lint-ignore no-explicit-any
function makeMockClient(opts: {
  updateResult: Record<string, unknown> | null;
  freshRow?: Record<string, unknown> | null;
}): any {
  let callCount = 0;
  let orFilter: string | null = null;
  // deno-lint-ignore no-explicit-any
  const chain: Record<string, any> = {
    select(_cols: string) { return chain; },
    update(_patch: Record<string, unknown>) { return chain; },
    eq(_col: string, _val: unknown) { return chain; },
    // Capture the filter string so tests can assert the exact predicate.
    or(filter: string) { orFilter = filter; return chain; },
    maybeSingle() {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve({ data: opts.updateResult, error: null });
      }
      return Promise.resolve({ data: opts.freshRow ?? null, error: null });
    },
  };
  // Expose capturedOrFilter() so tests can verify the .or() predicate passed
  // to the client. A wrong column name or missing null guard fails here rather
  // than silently passing because the mock never filtered anyway.
  return {
    from(_table: string) { return chain; },
    capturedOrFilter() { return orFilter; },
  };
}

Deno.test(
  'forward advance: incoming tip > stored, UPDATE fires, returns incoming tip',
  async () => {
    const client = makeMockClient({
      // UPDATE matched and returned the row (any non-null signals a write)
      updateResult: { last_block_scanned: 150 },
    });
    const result = await advanceCursor(client, PLATFORM_ID, CONN_ID, 150);
    assertEquals(isAdvanceCursorError(result), false);
    if (!isAdvanceCursorError(result)) {
      assertEquals(result.effectiveCursor, 150);
    }
  },
);

Deno.test(
  'forward-only guard no-op: incoming <= stored, UPDATE is a no-op, returns stored cursor',
  async () => {
    const client = makeMockClient({
      // UPDATE matched zero rows (stored cursor >= incoming)
      updateResult: null,
      // fresh re-read returns the actual stored value
      freshRow: { last_block_scanned: 100 },
    });
    const result = await advanceCursor(client, PLATFORM_ID, CONN_ID, 50);
    assertEquals(isAdvanceCursorError(result), false);
    if (!isAdvanceCursorError(result)) {
      // Must return the stored cursor (100), not the stale incoming tip (50)
      assertEquals(result.effectiveCursor, 100);
    }
  },
);

Deno.test(
  'concurrent no-op: concurrent caller advanced cursor past incoming, fresh re-read returns the max',
  async () => {
    const client = makeMockClient({
      // UPDATE was a no-op: a concurrent caller had already advanced the
      // cursor to 200, which is > our incoming tip of 150
      updateResult: null,
      // fresh re-read captures the concurrent caller's advance
      freshRow: { last_block_scanned: 200 },
    });
    const result = await advanceCursor(client, PLATFORM_ID, CONN_ID, 150);
    assertEquals(isAdvanceCursorError(result), false);
    if (!isAdvanceCursorError(result)) {
      // Must return 200 (the concurrent max), not 150 (our incoming tip)
      assertEquals(result.effectiveCursor, 200);
    }
  },
);

Deno.test(
  '.or() predicate contains the correct column, comparator, and null guard',
  async () => {
    // This test exists specifically to catch a broken .or() filter string.
    // The mock previously swallowed the filter without capturing it, so a
    // typo in the column name would pass all forward-only tests silently.
    const client = makeMockClient({
      updateResult: { last_block_scanned: 300 },
    });
    await advanceCursor(client, PLATFORM_ID, CONN_ID, 300);
    assertEquals(
      client.capturedOrFilter(),
      'last_block_scanned.lt.300,last_block_scanned.is.null',
    );
  },
);

Deno.test(
  'null cursor on no-op re-read returns 500 (invariant violation, not silent 0)',
  async () => {
    // The UPDATE predicate includes last_block_scanned.is.null, so a null
    // cursor always triggers the write and lands in the forward-advance branch.
    // If the re-read somehow returns null, the invariant has been violated and
    // cursor.ts must raise a 500 rather than returning 0 silently.
    const client = makeMockClient({
      updateResult: null,
      freshRow: { last_block_scanned: null },
    });
    const result = await advanceCursor(client, PLATFORM_ID, CONN_ID, 50);
    assertEquals(isAdvanceCursorError(result), true);
    if (isAdvanceCursorError(result)) {
      assertEquals(result.status, 500);
    }
  },
);
