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
 *
 * Plus the OR-T1914 contiguity ceiling at the bottom of this file: a caller may
 * not move this cursor above the height it reports having scanned without a
 * gap. That is the property the sibling endpoint already enforced on the same
 * column, and its absence here was the defect.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { advanceCursor, isAdvanceCursorError } from './cursor.ts';
import { boundCursorAdvance } from '../_shared/scan-cursor.ts';

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

// ── OR-T1914: the contiguity ceiling ──────────────────────────────────
//
// The failure this closes, concretely. A caller aborts its filter fetch at
// height 500. Its rolling-window extension pass matches a transaction at 900.
// It posts 900 as the cursor. The next sync resumes above 501-899, nobody ever
// scans those heights again, and a payment inside them is missing from the
// customer's balance permanently, with no error and no retry path.
//
// The ceiling can only hold the cursor back. Nothing below asserts it can raise
// one, because it must not be able to.

Deno.test(
  'OR-T1914: a height above the caller contiguous scan cannot move the cursor past it',
  async () => {
    const client = makeMockClient({
      updateResult: { last_block_scanned: 500 },
    });
    // Posts 900, admits it only read contiguously to 500.
    const result = await advanceCursor(client, PLATFORM_ID, CONN_ID, 900, 500);
    assertEquals(isAdvanceCursorError(result), false);
    if (!isAdvanceCursorError(result)) {
      assertEquals(result.effectiveCursor, 500);
      assertEquals(result.boundedHeight, 500);
    }
    // The predicate must compare against the BOUNDED height too. A write value
    // of 500 under a filter of lt.900 would still be forward-only, but it would
    // let a stored cursor of 700 be dragged backwards, which is a different bug.
    assertEquals(
      client.capturedOrFilter(),
      'last_block_scanned.lt.500,last_block_scanned.is.null',
    );
  },
);

Deno.test(
  'OR-T1914: no ceiling supplied leaves the posted height untouched',
  async () => {
    // Every caller that existed before OR-T1914 is in this case. If this test
    // fails, an integrator that sends only last_block_scanned has silently
    // changed behaviour.
    const client = makeMockClient({
      updateResult: { last_block_scanned: 900 },
    });
    const result = await advanceCursor(client, PLATFORM_ID, CONN_ID, 900);
    assertEquals(isAdvanceCursorError(result), false);
    if (!isAdvanceCursorError(result)) {
      assertEquals(result.effectiveCursor, 900);
      assertEquals(result.boundedHeight, 900);
    }
    assertEquals(
      client.capturedOrFilter(),
      'last_block_scanned.lt.900,last_block_scanned.is.null',
    );
  },
);

Deno.test(
  'OR-T1914: a ceiling above the posted height cannot raise the cursor',
  async () => {
    const client = makeMockClient({
      updateResult: { last_block_scanned: 400 },
    });
    const result = await advanceCursor(client, PLATFORM_ID, CONN_ID, 400, 900);
    assertEquals(isAdvanceCursorError(result), false);
    if (!isAdvanceCursorError(result)) {
      assertEquals(result.effectiveCursor, 400);
      assertEquals(result.boundedHeight, 400);
    }
  },
);

Deno.test(
  'OR-T1914: boundedHeight is returned on the no-op path, so the scan range stays bounded',
  async () => {
    // The handler records the scan range against boundedHeight. On the no-op
    // path the cursor did not move, but the range still must not claim the
    // caller read up to the height it posted.
    const client = makeMockClient({
      updateResult: null,
      freshRow: { last_block_scanned: 700 },
    });
    const result = await advanceCursor(client, PLATFORM_ID, CONN_ID, 900, 500);
    assertEquals(isAdvanceCursorError(result), false);
    if (!isAdvanceCursorError(result)) {
      assertEquals(result.effectiveCursor, 700);
      assertEquals(result.boundedHeight, 500);
    }
  },
);

Deno.test(
  'OR-T1914: the ceiling is the shared contract helper, not a local rule',
  () => {
    // If this endpoint ever grows its own private version of the ceiling, the
    // two functions writing this column can drift apart again, which is the
    // whole defect. min semantics, and an unusable value means no ceiling.
    assertEquals(boundCursorAdvance(900, 500), 500);
    assertEquals(boundCursorAdvance(400, 900), 400);
    assertEquals(boundCursorAdvance(900, undefined), 900);
    assertEquals(boundCursorAdvance(900, -1), 900);
    assertEquals(boundCursorAdvance(900, 12.5), 900);
    assertEquals(boundCursorAdvance(900, '500'), 900);
  },
);
