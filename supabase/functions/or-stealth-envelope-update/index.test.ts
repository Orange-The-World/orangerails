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
 * Plus the OR-T1914 contiguity ceiling: a caller may not move this cursor
 * above the height it reports having scanned without a gap. That is the
 * property the sibling endpoint already enforced on the same column, and its
 * absence here was the defect.
 *
 * Plus OR-T2457 at the bottom: a caller whose scan_generation does not match
 * the connection's current one is refused (409), never folded into an
 * ordinary no-op response. Every test above this point passes a
 * scanGeneration that matches what the mock reports as current, so the check
 * is a pass-through for them and none of their original assertions changed.
 * The full end-to-end reproduction (a reset, then a stale write, then
 * proving the next sync still starts at the new birthday) lives in
 * generation_fence.test.ts, alongside this unit-level proof of the check
 * itself.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { advanceCursor, isAdvanceCursorError } from './cursor.ts';
import { boundCursorAdvance } from '../_shared/scan-cursor.ts';

const PLATFORM_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CONN_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
// Used wherever a test does not care about generation fencing: the mock
// reports it back unchanged, so every existing case passes the check.
const GEN = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

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
  const eqFilters: Record<string, unknown> = {};
  // deno-lint-ignore no-explicit-any
  const chain: Record<string, any> = {
    select(_cols: string) { return chain; },
    update(_patch: Record<string, unknown>) { return chain; },
    eq(col: string, val: unknown) { eqFilters[col] = val; return chain; },
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
    capturedEq(col: string) { return eqFilters[col]; },
  };
}

Deno.test(
  'forward advance: incoming tip > stored, UPDATE fires, returns incoming tip',
  async () => {
    const client = makeMockClient({
      // UPDATE matched and returned the row (any non-null signals a write)
      updateResult: { last_block_scanned: 150 },
    });
    const result = await advanceCursor(client, PLATFORM_ID, CONN_ID, 150, GEN);
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
      // fresh re-read returns the actual stored value, same generation the
      // caller sent: this is a genuine forward-only no-op, not a reset.
      freshRow: { last_block_scanned: 100, scan_generation: GEN },
    });
    const result = await advanceCursor(client, PLATFORM_ID, CONN_ID, 50, GEN);
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
      freshRow: { last_block_scanned: 200, scan_generation: GEN },
    });
    const result = await advanceCursor(client, PLATFORM_ID, CONN_ID, 150, GEN);
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
    await advanceCursor(client, PLATFORM_ID, CONN_ID, 300, GEN);
    assertEquals(
      client.capturedOrFilter(),
      'last_block_scanned.lt.300,last_block_scanned.is.null',
    );
    assertEquals(client.capturedEq('scan_generation'), GEN);
  },
);

Deno.test(
  'null cursor on no-op re-read returns 500 (invariant violation, not silent 0)',
  async () => {
    // The UPDATE predicate includes last_block_scanned.is.null, so a null
    // cursor always triggers the write and lands in the forward-advance branch.
    // If the re-read somehow returns null, the invariant has been violated and
    // cursor.ts must raise a 500 rather than returning 0 silently. Generation
    // matches here so the OR-T2457 check does not mask this invariant check.
    const client = makeMockClient({
      updateResult: null,
      freshRow: { last_block_scanned: null, scan_generation: GEN },
    });
    const result = await advanceCursor(client, PLATFORM_ID, CONN_ID, 50, GEN);
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
    const result = await advanceCursor(client, PLATFORM_ID, CONN_ID, 900, GEN, 500);
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
    const result = await advanceCursor(client, PLATFORM_ID, CONN_ID, 900, GEN);
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
    const result = await advanceCursor(client, PLATFORM_ID, CONN_ID, 400, GEN, 900);
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
      freshRow: { last_block_scanned: 700, scan_generation: GEN },
    });
    const result = await advanceCursor(client, PLATFORM_ID, CONN_ID, 900, GEN, 500);
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

// ── OR-T2457: the generation fence ──────────────────────────────────────
//
// scan_generation is required (unlike the OR-T1914 ceiling above): a caller
// with no fresh token is indistinguishable from one carrying a stale one, so
// there is no safe permissive default. These two cases live at the
// advanceCursor unit level; the full reset-then-stale-write reproduction is
// in generation_fence.test.ts.

Deno.test(
  'OR-T2457: a generation mismatch on the no-op path is refused (409), not read as an ordinary no-op',
  async () => {
    // UPDATE matched zero rows because the row's generation is not GEN (it
    // was reset), not because the forward-only guard tripped. The mock's
    // freshRow reports the connection's ACTUAL current generation, which
    // differs from what this caller is still carrying.
    const client = makeMockClient({
      updateResult: null,
      freshRow: { last_block_scanned: null, scan_generation: 'after-a-reset' },
    });
    const result = await advanceCursor(client, PLATFORM_ID, CONN_ID, 12345, GEN);
    assertEquals(isAdvanceCursorError(result), true);
    if (isAdvanceCursorError(result)) {
      assertEquals(result.status, 409);
    }
    assertEquals(client.capturedEq('scan_generation'), GEN);
  },
);

Deno.test(
  'OR-T2457: a matching generation on the no-op path behaves exactly as before',
  async () => {
    const client = makeMockClient({
      updateResult: null,
      freshRow: { last_block_scanned: 250, scan_generation: GEN },
    });
    const result = await advanceCursor(client, PLATFORM_ID, CONN_ID, 100, GEN);
    assertEquals(isAdvanceCursorError(result), false);
    if (!isAdvanceCursorError(result)) {
      assertEquals(result.effectiveCursor, 250);
    }
  },
);
