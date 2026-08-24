/**
 * DL-1568: no queue table may exist without somebody accounting for it.
 *
 * Run with:
 *   deno test --no-check --allow-read supabase/functions/or-queue-health/queues.test.ts
 *
 * The coverage test is the point of this file. The threshold tests below it are
 * ordinary and would not be worth writing on their own.
 *
 * A per-pipeline alert only ever covers the pipeline somebody was thinking
 * about when they wrote it. Both drain outages this estate has had were on
 * queues nobody was thinking about, and in both cases the gap was invisible
 * because there was no list of queues to be absent from. So the list is in
 * queues.ts, and this test walks the migrations and fails when a table that
 * looks like a queue is not on it. Adding a queue then forces a deliberate
 * choice: a threshold, or a named owner who already watches it.
 */

import {
  assert,
  assertEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { ageHours, isStalled, QUEUES, watchedQueues } from './queues.ts';

/** Timestamp columns that mean "this row joined a queue". */
const ENQUEUED_COLUMNS = ['created_at', 'received_at'];
/** Timestamp columns that mean "this row left it". */
const DRAINED_COLUMNS = ['processed_at', 'succeeded_at'];

/**
 * Tables declared in migrations that carry both an enqueue and a drain column.
 *
 * Reads the migrations rather than the database, because CI has no database.
 * That is a real limitation and worth naming: a table created by hand and never
 * written into a migration is invisible here. Hand-applied DDL that no
 * migration records has already happened in this repo, so this test is a floor
 * and not a ceiling.
 */
function queueTablesInMigrations(): string[] {
  const dir = new URL('../../migrations/', import.meta.url);
  const found = new Set<string>();

  for (const entry of Deno.readDirSync(dir)) {
    if (!entry.name.endsWith('.sql')) continue;
    const sql = Deno.readTextFileSync(new URL(entry.name, dir));

    const creates = sql.matchAll(
      /CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/gi,
    );
    for (const m of creates) {
      const [, table, body] = m;
      const hasEnqueue = ENQUEUED_COLUMNS.some((c) =>
        new RegExp(`^\\s*${c}\\s+TIMESTAMPTZ`, 'im').test(body)
      );
      const hasDrain = DRAINED_COLUMNS.some((c) =>
        new RegExp(`^\\s*${c}\\s+TIMESTAMPTZ`, 'im').test(body)
      );
      if (hasEnqueue && hasDrain) found.add(table);
    }
  }
  return [...found].sort();
}

Deno.test('every queue table in the migrations is accounted for', () => {
  const declared = new Set(QUEUES.map((q) => q.table));
  const inMigrations = queueTablesInMigrations();

  assert(
    inMigrations.length > 0,
    'scanned the migrations and found no queue tables at all, which means the ' +
      'scan is broken rather than that none exist. Fix the scan, do not relax ' +
      'this assertion.',
  );

  const uncovered = inMigrations.filter((t) => !declared.has(t));
  assertEquals(
    uncovered,
    [],
    'these tables look like queues and are not in QUEUES. Add each one with ' +
      'either a stallHours threshold or a named owner that already watches ' +
      'it, and say what an age probe cannot see about it: ' + uncovered.join(', '),
  );
});

Deno.test('nothing is declared that does not exist', () => {
  // The reverse direction. A stale entry means the probe queries a table that
  // is gone, which fails at runtime and, because a failed query fires, would
  // alert forever on a queue nobody has any more.
  const inMigrations = new Set(queueTablesInMigrations());
  const orphans = QUEUES.map((q) => q.table).filter((t) => !inMigrations.has(t));
  assertEquals(orphans, [], 'declared but not created by any migration: ' + orphans.join(', '));
});

Deno.test('every queue says what the probe cannot see about it', () => {
  // blindSpots is required by the type, so this guards against the other
  // failure: satisfying the compiler with an empty array. A probe whose limits
  // are undocumented gets trusted past them, and a monitor trusted past its
  // limits is worse than no monitor, because it manufactures confidence.
  for (const q of QUEUES) {
    assert(
      q.blindSpots.length > 0,
      `${q.table} declares no blind spots. Every queue has at least one: ` +
        'an age probe cannot see a queue nothing can write to, and cannot see ' +
        'a row destroyed rather than drained.',
    );
  }
});

Deno.test('a delegated queue names an owner and is not queried here', () => {
  const delegated = QUEUES.filter((q) => q.coverage.kind === 'delegated');
  assert(delegated.length > 0, 'expected at least quiltt_webhook_inbox to be delegated');

  for (const q of delegated) {
    if (q.coverage.kind !== 'delegated') continue;
    assert(q.coverage.owner.length > 0, `${q.table} is delegated to nobody`);
    assert(q.coverage.why.length > 0, `${q.table} does not say why it is delegated`);
  }

  const watchedNames = watchedQueues().map((q) => q.table);
  for (const q of delegated) {
    assertEquals(
      watchedNames.includes(q.table),
      false,
      `${q.table} is delegated but would still be queried, so both probes ` +
        'would post the same stall to the same topic',
    );
  }
});

Deno.test('the outbound delivery queue is watched, and by this probe', () => {
  // Pinned by name. This is the queue whose ten-week outage produced the
  // ticket; a refactor that quietly drops it should fail loudly.
  const wd = QUEUES.find((q) => q.table === 'webhook_delivery');
  assert(wd, 'webhook_delivery is not in the coverage map');
  assertEquals(wd.coverage.kind, 'watched');
  assertEquals(wd.drainedAt, 'succeeded_at');
  // Not delivered_at. That column does not exist and guessing it cost real time.
});

Deno.test('age and threshold arithmetic', () => {
  const now = new Date('2026-08-24T12:00:00.000Z');

  assertEquals(ageHours(null, now), null, 'an empty queue has no age');
  assertEquals(ageHours('2026-08-24T10:00:00.000Z', now), 2);
  assertEquals(ageHours('not a date', now), null, 'an unparseable timestamp is not an age');

  const wd = QUEUES.find((q) => q.table === 'webhook_delivery')!;

  assertEquals(isStalled(wd, null, now), false, 'an empty queue is not stalled');
  assertEquals(
    isStalled(wd, '2026-08-24T11:00:00.000Z', now),
    false,
    'one hour is inside the two hour threshold',
  );
  assertEquals(
    isStalled(wd, '2026-08-24T09:00:00.000Z', now),
    true,
    'three hours is past it',
  );
  assertEquals(
    isStalled(wd, '2026-06-11T00:00:00.000Z', now),
    true,
    'the real observed backlog, 74 days, must fire',
  );

  const inbox = QUEUES.find((q) => q.table === 'quiltt_webhook_inbox')!;
  assertEquals(
    isStalled(inbox, '2026-06-11T00:00:00.000Z', now),
    false,
    'a delegated queue never fires here, however old its oldest row is',
  );
});
