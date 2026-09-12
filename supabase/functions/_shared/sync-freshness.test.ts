/**
 * Deno tests for the read-time sync freshness signal. DL-1737.
 *
 * Run with:
 *   deno test supabase/functions/_shared/sync-freshness.test.ts
 *
 * WHAT WOULD ACTUALLY CATCH A REGRESSION HERE. The failure mode is a
 * threshold that moves without anyone noticing, so the happy-path cases are
 * close to worthless on their own: "1 hour is fresh, 28 days is stale" passes
 * for any threshold between one hour and four weeks. The tests that carry
 * weight are the ones an hour either side of the line, and the one exactly on
 * it, because those fail the moment the number or the comparison operator
 * changes.
 *
 * The second failure mode is quieter: `hours_since_sync` and `sync_freshness`
 * disagreeing inside the same response, so a client that re-derives the
 * verdict from the number gets a different answer to the one we sent. That is
 * pinned explicitly rather than left to inspection.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  computeSyncFreshness,
  STALE_AFTER_HOURS,
} from './sync-freshness.ts';

/**
 * A fixed clock. Every case is built by subtracting from this, so the tests
 * describe an age rather than a date and cannot rot as the calendar moves.
 */
const NOW = new Date('2026-08-27T12:00:00.000Z');
const MS_PER_HOUR = 3_600_000;

/** An ISO stamp exactly `hours` old relative to NOW. */
function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * MS_PER_HOUR).toISOString();
}

Deno.test('the threshold is 72 hours and it is reported in the payload', () => {
  assertEquals(STALE_AFTER_HOURS, 72);
  assertEquals(computeSyncFreshness(hoursAgo(1), NOW).stale_after_hours, 72);
  assertEquals(computeSyncFreshness(null, NOW).stale_after_hours, 72);
});

Deno.test('null last_sync_at is never, with no hours to report', () => {
  const result = computeSyncFreshness(null, NOW);
  assertEquals(result.sync_freshness, 'never');
  assertEquals(result.hours_since_sync, null);
});

Deno.test('undefined and empty string are never, not fresh', () => {
  assertEquals(computeSyncFreshness(undefined, NOW).sync_freshness, 'never');
  assertEquals(computeSyncFreshness('', NOW).sync_freshness, 'never');
});

Deno.test('an unparseable stamp is never, never fresh', () => {
  // A path that recognised nothing must not return the value that means all
  // is well. Garbage in the column is not evidence that a sync happened.
  for (const bad of ['not-a-date', '0000-13-45T99:99:99Z', 'null', '   ']) {
    const result = computeSyncFreshness(bad, NOW);
    assertEquals(result.sync_freshness, 'never', `expected never for ${bad}`);
    assertEquals(result.hours_since_sync, null, `expected null hours for ${bad}`);
  }
});

Deno.test('one hour old is fresh', () => {
  const result = computeSyncFreshness(hoursAgo(1), NOW);
  assertEquals(result.sync_freshness, 'fresh');
  assertEquals(result.hours_since_sync, 1);
});

Deno.test('71 hours old is fresh, one hour inside the line', () => {
  const result = computeSyncFreshness(hoursAgo(71), NOW);
  assertEquals(result.sync_freshness, 'fresh');
  assertEquals(result.hours_since_sync, 71);
});

Deno.test('exactly 72 hours old is fresh, the boundary is inclusive', () => {
  const result = computeSyncFreshness(hoursAgo(72), NOW);
  assertEquals(result.sync_freshness, 'fresh');
  assertEquals(result.hours_since_sync, 72);
});

Deno.test('73 hours old is stale, one hour past the line', () => {
  const result = computeSyncFreshness(hoursAgo(73), NOW);
  assertEquals(result.sync_freshness, 'stale');
  assertEquals(result.hours_since_sync, 73);
});

Deno.test('28 days old is stale, and reports its real age', () => {
  // The production case this ticket exists for: 13 to 28 days of silence
  // reported as a healthy connection.
  const result = computeSyncFreshness(hoursAgo(28 * 24), NOW);
  assertEquals(result.sync_freshness, 'stale');
  assertEquals(result.hours_since_sync, 672);
});

Deno.test('hours_since_sync and sync_freshness never disagree', () => {
  // A client that re-derives the verdict from the number we sent must get the
  // answer we sent. This is why the verdict is computed from the ROUNDED
  // value rather than from the raw millisecond difference.
  const cases = [0.004, 1, 71.994, 71.996, 72, 72.004, 72.006, 73, 672];
  for (const age of cases) {
    const result = computeSyncFreshness(hoursAgo(age), NOW);
    const hours = result.hours_since_sync;
    if (hours === null) throw new Error(`unexpected null hours for age ${age}`);
    const reDerived = hours <= result.stale_after_hours ? 'fresh' : 'stale';
    assertEquals(
      result.sync_freshness,
      reDerived,
      `payload says ${result.sync_freshness} but ${hours}h re-derives to ${reDerived}`,
    );
  }
});

Deno.test('a future stamp reports negative hours rather than a clamped zero', () => {
  // Clock skew is reported, not hidden. A clamped zero would read as a sync
  // that just happened, which is the exact false reassurance this signal
  // exists to remove.
  const result = computeSyncFreshness(hoursAgo(-5), NOW);
  assertEquals(result.hours_since_sync, -5);
  assertEquals(result.sync_freshness, 'fresh');
});

Deno.test('the clock is a parameter, so one response measures one instant', () => {
  // Two rows stamped at the same instant must land on the same side of the
  // threshold. If the function read the clock itself, a slow response could
  // put them on either side.
  const stamp = hoursAgo(72);
  const later = new Date(NOW.getTime() + 2 * MS_PER_HOUR);
  assertEquals(computeSyncFreshness(stamp, NOW).sync_freshness, 'fresh');
  assertEquals(computeSyncFreshness(stamp, later).sync_freshness, 'stale');
});
