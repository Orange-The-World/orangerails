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

Deno.test('snapshotsMatch is false when nothing was stored', () => {
  assertEquals(snapshotsMatch(null, stallOnly(25, 60)), false);
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
