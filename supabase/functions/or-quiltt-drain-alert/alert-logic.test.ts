/**
 * Behaviour tests for the pure helpers in alert-logic.ts.
 *
 * Run with:
 *   deno test --no-check --allow-read supabase/functions/or-quiltt-drain-alert/alert-logic.test.ts
 *
 * index.test.ts can only read index.ts as text. These tests actually run the
 * repeat-alert comparison, which is the part that was silently broken.
 */

import { assertEquals, assertNotEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { normalizeSnapshot, projectLabel, snapshotsMatch } from './alert-logic.ts';
import type { SignalSnapshot } from './alert-logic.ts';

const quiet: SignalSnapshot = {
  failure_rate_firing:      false,
  failure_rate:             0,
  zero_completions_firing:  false,
  succeeded_count:          60,
  stall_firing:             false,
  stalled:                  0,
  retired_firing:           false,
  retired:                  0,
  query_error:              null,
  starvation_firing:        false,
  unprocessed_non_deferred: 0,
  deferred_firing:          false,
  deferred_unprocessed:     0,
};

/** A snapshot in which only the queue stall signal is firing. */
const stallOnly = (stalled: number, succeeded: number): SignalSnapshot => ({
  ...quiet,
  stall_firing:    true,
  stalled,
  succeeded_count: succeeded,
});

/** Same content, with the key order Postgres jsonb returns: shorter first, then alphabetical. */
function asJsonbReturns(s: SignalSnapshot): SignalSnapshot {
  const ordered = Object.entries(s).sort(
    ([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  return Object.fromEntries(ordered) as unknown as SignalSnapshot;
}

Deno.test('normalizeSnapshot gives the same text whatever order the keys arrived in', () => {
  const built = stallOnly(25, 60);
  const stored = asJsonbReturns(built);
  // Guard the fixture: the reordered copy really does serialize differently.
  assertNotEquals(JSON.stringify(stored), JSON.stringify(built));
  assertEquals(
    JSON.stringify(normalizeSnapshot(stored)),
    JSON.stringify(normalizeSnapshot(built)),
  );
});

Deno.test('snapshotsMatch treats the jsonb copy of an unchanged state as unchanged', () => {
  const built = stallOnly(25, 60);
  const stored = asJsonbReturns(built);
  // The old comparison, kept as a control: it saw a change where there was none.
  assertNotEquals(JSON.stringify(stored), JSON.stringify(built));
  assertEquals(snapshotsMatch(stored, built), true);
});

Deno.test('snapshotsMatch ignores succeeded_count while zero completions is not firing', () => {
  const stored = asJsonbReturns(stallOnly(25, 60));
  assertEquals(snapshotsMatch(stored, stallOnly(25, 59)), true);
  assertEquals(snapshotsMatch(stored, stallOnly(25, 61)), true);
});

/** A snapshot in which only the deferred backlog signal is firing. */
const deferredOnly = (deferred: number): SignalSnapshot => ({
  ...quiet,
  deferred_firing:      true,
  deferred_unprocessed: deferred,
});

Deno.test('snapshotsMatch reports a moved deferred count while the deferred signal is firing', () => {
  const stored = asJsonbReturns(deferredOnly(30));
  assertEquals(snapshotsMatch(stored, deferredOnly(30)), true);
  assertEquals(snapshotsMatch(stored, deferredOnly(31)), false);
  assertEquals(snapshotsMatch(stored, deferredOnly(29)), false);
  assertEquals(snapshotsMatch(stored, quiet), false);
});

Deno.test('snapshotsMatch ignores a deferred count while the deferred signal is not firing', () => {
  assertEquals(normalizeSnapshot({ ...quiet, deferred_unprocessed: 7 }).deferred_unprocessed, null);
  assertEquals(normalizeSnapshot(deferredOnly(7)).deferred_unprocessed, 7);
  assertEquals(snapshotsMatch(asJsonbReturns(quiet), { ...quiet, deferred_unprocessed: 7 }), true);
});

Deno.test('snapshotsMatch is false when nothing was stored', () => {
  assertEquals(snapshotsMatch(null, stallOnly(25, 60)), false);
});

Deno.test('a signal that clears and returns with the same counts reads as a repeat until the snapshot is reset', () => {
  // 10:00 one stalled row is posted and its snapshot is stored.
  const stored = asJsonbReturns(stallOnly(1, 60));
  // 12:30 the stall is back with the very same counts after a quiet stretch.
  const returned = stallOnly(1, 61);
  // Control: with the stored snapshot left in place this is the same incident,
  // which is what held the second post back until the 6 hour ceiling.
  assertEquals(snapshotsMatch(stored, returned), true);
  // A quiet run stores null (see the wiring guards below), and then it is new.
  assertEquals(snapshotsMatch(null, returned), false);
});

Deno.test('snapshotsMatch still reports every real change', () => {
  const stored = asJsonbReturns(stallOnly(25, 60));
  // The stalled count moved.
  assertEquals(snapshotsMatch(stored, stallOnly(26, 60)), false);
  // A second signal started firing.
  assertEquals(
    snapshotsMatch(stored, { ...stallOnly(25, 60), retired_firing: true, retired: 3 }),
    false,
  );
  // The stall cleared.
  assertEquals(snapshotsMatch(stored, quiet), false);
  // A query error appeared.
  assertEquals(
    snapshotsMatch(stored, { ...stallOnly(25, 60), query_error: 'signal C (queue stall): timeout' }),
    false,
  );
  // Zero completions started firing, so succeeded_count now matters.
  assertEquals(
    snapshotsMatch(stored, { ...stallOnly(25, 0), zero_completions_firing: true }),
    false,
  );
});

Deno.test('projectLabel returns the first host name label of the project url', () => {
  assertEquals(projectLabel('https://abcdefghijklmnop.supabase.co'), 'abcdefghijklmnop');
  assertEquals(projectLabel('https://abcdefghijklmnop.supabase.co/'), 'abcdefghijklmnop');
});

Deno.test('projectLabel never throws and never returns an empty label', () => {
  assertEquals(projectLabel(undefined), 'unknown project');
  assertEquals(projectLabel(null), 'unknown project');
  assertEquals(projectLabel(''), 'unknown project');
  assertEquals(projectLabel('not a url'), 'unknown project');
});

// The reset itself is I/O inside the Deno.serve entrypoint, which a test cannot
// import, so it is pinned as source text, like the test after these two.
Deno.test('a quiet run clears only the saved snapshot, never the last post time', () => {
  const src = Deno.readTextFileSync(new URL('./index.ts', import.meta.url));
  // Clearing last_notified_at as well would drop the 60 minute floor and let a
  // flapping signal post on every oscillation.
  assertEquals(
    /\.update\(\{\s*last_signal_snapshot:\s*null\s*\}\)\s*\.eq\('id',\s*1\)\s*\.not\('last_signal_snapshot',\s*'is',\s*null\)/.test(src),
    true,
    'the quiet run must clear last_signal_snapshot alone, for row 1, and only while it is set',
  );
  assertEquals(
    /last_notified_at:\s*null/.test(src),
    false,
    'no path may clear last_notified_at: that would drop the 60 minute floor',
  );
});

Deno.test('the snapshot reset sits on the nothing-firing path and nowhere else', () => {
  const src = Deno.readTextFileSync(new URL('./index.ts', import.meta.url));
  const start = src.indexOf('if (alertFiring) {');
  assertEquals(start > 0, true, 'index.ts must still branch on alertFiring');
  const fromFiring = src.slice(start);
  // The firing branch closes at two spaces of indent and the quiet branch follows it.
  const quietAt = fromFiring.indexOf('\n  } else {');
  assertEquals(quietAt > 0, true, 'the alertFiring branch must have a quiet-run else branch');
  assertEquals(
    fromFiring.slice(0, quietAt).includes('last_signal_snapshot: null'),
    false,
    'a run that is firing, or could not run a probe, must never clear the snapshot',
  );
  assertEquals(
    /\.update\(\{\s*last_signal_snapshot:\s*null\s*\}\)/.test(fromFiring.slice(quietAt)),
    true,
    'a run with nothing firing must clear the snapshot',
  );
});

Deno.test('index.ts uses the imported comparison and names the project in its alert', () => {
  const src = Deno.readTextFileSync(new URL('./index.ts', import.meta.url));
  // A second local copy of the comparison would bring the raw JSON.stringify back.
  assertEquals(src.includes('function snapshotsMatch'), false);
  assertEquals(src.includes("from './alert-logic.ts'"), true);
  // The header names the project and both mentions stay unwrapped so they notify.
  assertEquals(
    src.includes(
      "or_quiltt_sync_drain alert (${projectLabel(Deno.env.get('SUPABASE_URL'))})** @**CTO Rails** @**SRE**",
    ),
    true,
  );
});
