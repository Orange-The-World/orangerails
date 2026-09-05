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
import {
  ageHours,
  classify,
  QUEUES,
  unmonitoredQueues,
  watchedQueues,
} from './queues.ts';

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
 *
 * TWO SCANNING BUGS THIS FUNCTION USED TO HAVE, both of which let a real queue
 * slip past unnoticed, which is the exact thing this file exists to prevent:
 *
 *   1. It only read CREATE TABLE bodies. A queue built up over two migrations,
 *      the table first and `processed_at` added later by ALTER TABLE, never
 *      showed both columns in one body and so was never detected. Columns are
 *      now accumulated PER TABLE across every migration.
 *   2. It matched only the literal `TIMESTAMPTZ`. Postgres accepts
 *      `TIMESTAMP WITH TIME ZONE` for the identical type and migrations in this
 *      repo use both spellings.
 *   3. Its CREATE TABLE terminator was `\n\);`, which requires the closing
 *      paren at column zero. Every migration in this repo happens to be written
 *      that way, so the bug was invisible until a fixture indented one. Found by
 *      the fixture test below, which is the argument for having it.
 */
const TIMESTAMP_TYPE = '(?:TIMESTAMPTZ|TIMESTAMP\\s+WITH\\s+TIME\\s+ZONE)';

/**
 * The parsing, as a pure function over SQL text, so it can be tested against a
 * fixture instead of only against whatever the real migrations happen to
 * contain. That distinction matters: the first version of the regression test
 * below asserted on real tables, and those tables were discoverable through the
 * CREATE TABLE path anyway, so the test passed with the ALTER TABLE handling
 * deleted. It proved nothing. A test that cannot go red is not a test.
 */
export function queueTablesInSql(sources: string[]): string[] {
  /** table -> the timestamp columns any migration gives it. */
  const columnsByTable = new Map<string, Set<string>>();

  const note = (table: string, column: string) => {
    const key = table.toLowerCase();
    if (!columnsByTable.has(key)) columnsByTable.set(key, new Set());
    columnsByTable.get(key)!.add(column.toLowerCase());
  };

  const interesting = [...ENQUEUED_COLUMNS, ...DRAINED_COLUMNS];

  for (const sql of sources) {
    // CREATE TABLE bodies.
    const creates = sql.matchAll(
      /CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\s*\);/gi,
    );
    for (const m of creates) {
      const [, table, body] = m;
      for (const c of interesting) {
        if (new RegExp(`^\\s*${c}\\s+${TIMESTAMP_TYPE}`, 'im').test(body)) note(table, c);
      }
    }

    // ALTER TABLE ... ADD COLUMN, which the old scanner could not see at all.
    //
    // Matched as WHOLE STATEMENTS, then every ADD COLUMN clause inside each one.
    // A per-clause regex anchored on `ALTER TABLE` only ever sees the first
    // column, and the comma-separated form is the house style here: over ten
    // migrations use it, including the one that created webhook_delivery
    // (`ADD COLUMN webhook_url TEXT, ADD COLUMN webhook_secret TEXT`). A queue
    // written that way would have sailed through the coverage gate.
    const alterStatements = sql.matchAll(
      /ALTER TABLE\s+(?:IF EXISTS\s+)?(?:public\.)?(\w+)([^;]*);/gi,
    );
    for (const stmt of alterStatements) {
      const [, table, body] = stmt;
      const addClauses = body.matchAll(
        new RegExp(`ADD COLUMN\\s+(?:IF NOT EXISTS\\s+)?(\\w+)\\s+${TIMESTAMP_TYPE}`, 'gi'),
      );
      for (const c of addClauses) {
        const column = c[1];
        if (interesting.includes(column.toLowerCase())) note(table, column);
      }
    }
  }

  const found: string[] = [];
  for (const [table, cols] of columnsByTable) {
    const hasEnqueue = ENQUEUED_COLUMNS.some((c) => cols.has(c));
    const hasDrain = DRAINED_COLUMNS.some((c) => cols.has(c));
    if (hasEnqueue && hasDrain) found.push(table);
  }
  return found.sort();
}

/** The real scan: every migration on disk, through the same parser. */
function queueTablesInMigrations(): string[] {
  const dir = new URL('../../migrations/', import.meta.url);
  const sources: string[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    if (!entry.name.endsWith('.sql')) continue;
    sources.push(Deno.readTextFileSync(new URL(entry.name, dir)));
  }
  return queueTablesInSql(sources);
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

  assertEquals(
    classify(wd, null, now).state,
    'ok',
    'an empty queue is the healthiest possible answer',
  );
  assertEquals(
    classify(wd, '2026-08-24T11:00:00.000Z', now).state,
    'ok',
    'one hour is inside the two hour threshold',
  );
  assertEquals(
    classify(wd, '2026-08-24T09:00:00.000Z', now).state,
    'stalled',
    'three hours is past it',
  );
  assertEquals(
    classify(wd, '2026-06-11T00:00:00.000Z', now).state,
    'stalled',
    'the real observed backlog, 74 days, must fire',
  );
});

Deno.test('a probe that could not check never reports OK', () => {
  // Ruled on #378, 2026-08-01: "I could not check must never report as
  // OK". This is the test for that sentence. A boolean return type made this
  // impossible to express, which is why the return type is three states.
  const now = new Date('2026-08-24T12:00:00.000Z');
  const wd = QUEUES.find((q) => q.table === 'webhook_delivery')!;

  const failed = classify(wd, null, now, 'connection refused');
  assertEquals(failed.state, 'unknown', 'a failed lookup is not a healthy queue');
  assert(
    failed.state === 'unknown' && failed.why.includes('connection refused'),
    'the reason we could not check must survive into the verdict',
  );

  const unparseable = classify(wd, 'not a date', now);
  assertEquals(
    unparseable.state,
    'unknown',
    'a row whose timestamp will not parse is an unknown, not an empty queue',
  );

  const inbox = QUEUES.find((q) => q.table === 'quiltt_webhook_inbox')!;
  assertEquals(
    classify(inbox, '2026-06-11T00:00:00.000Z', now).state,
    'unknown',
    'a delegated queue is unknown TO THIS PROBE, never ok: this probe did not ' +
      'check it and must not imply that it did',
  );
});

Deno.test('a queue with no scheduled drain is unmonitorable, not watched', () => {
  // The defect this test pins: strike_webhook_events was given a 2 hour age
  // threshold, but drainStrikeQueue is only ever called from or-sync, the
  // user-initiated endpoint, because the drain needs the user's unlock key.
  // Rows therefore wait for their owner to open the app. A 2 hour threshold
  // would have alerted continuously for every inactive user, which is how an
  // alert channel gets muted and then ignored when it finally matters.
  const strike = QUEUES.find((q) => q.table === 'strike_webhook_events');
  assert(strike, 'strike_webhook_events is not in the coverage map');
  assertEquals(
    strike.coverage.kind,
    'unmonitorable',
    'strike_webhook_events has no scheduled drain, so age cannot be its signal',
  );
  assert(
    strike.coverage.kind === 'unmonitorable' && strike.coverage.needs.length > 0,
    'an unmonitorable queue must say what would actually be needed to cover it',
  );
  assertEquals(
    watchedQueues().map((q) => q.table).includes('strike_webhook_events'),
    false,
    'an unmonitorable queue must never be queried as if it were watched',
  );
});

Deno.test('an unwatched queue is still named in the report', () => {
  // The failure this pins: if the report only lists queues the probe queried,
  // then a run where every watched queue is healthy looks identical to a run
  // where nothing is uncovered. strike_webhook_events would vanish from a green
  // report despite being the one queue we know nobody is watching.
  const unmonitored = unmonitoredQueues();
  assertEquals(
    unmonitored.map((q) => q.table),
    ['strike_webhook_events'],
    'the uncovered queue must be reportable independently of any alert',
  );
  for (const q of unmonitored) {
    assert(
      q.coverage.kind === 'unmonitorable' && q.coverage.needs.length > 0,
      `${q.table} is uncovered but does not say what would cover it`,
    );
  }
});

Deno.test('the scanner sees a queue assembled across two migrations', () => {
  // A fixture, not the real migrations. Deleting the ALTER TABLE handling makes
  // this go red; asserting on real tables did not, because they are all
  // discoverable through CREATE TABLE alone.
  const createOnly = `
    CREATE TABLE IF NOT EXISTS public.late_bound_queue (
      id UUID PRIMARY KEY,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `;
  const drainAddedLater = `
    ALTER TABLE public.late_bound_queue
      ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
  `;

  assertEquals(
    queueTablesInSql([createOnly]),
    [],
    'with only the enqueue column it is not yet a queue',
  );
  assertEquals(
    queueTablesInSql([createOnly, drainAddedLater]),
    ['late_bound_queue'],
    'a drain column added by a later migration must still be detected',
  );
});

Deno.test('the scanner sees every ADD COLUMN clause in one ALTER TABLE', () => {
  // The comma-separated form is the house style here: over ten migrations use
  // it, including the one that created webhook_delivery. A regex anchored on
  // `ALTER TABLE` before each clause reads only the first column, so a queue
  // written this way would pass the coverage gate with no QUEUES entry, which
  // is the precise hole this whole test file exists to close.
  const bothInOneStatement = `
    CREATE TABLE public.combined_queue (
      id UUID PRIMARY KEY
    );
    ALTER TABLE public.combined_queue
      ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
  `;
  assertEquals(
    queueTablesInSql([bothInOneStatement]),
    ['combined_queue'],
    'the second ADD COLUMN clause must be seen, not just the first',
  );
});

Deno.test('the scanner accepts both spellings of the timestamp type', () => {
  // Postgres treats these as the same type and this repo uses both. Matching
  // only the literal TIMESTAMPTZ silently skipped whole tables.
  const spelledOut = `
    CREATE TABLE public.verbose_queue (
      id UUID PRIMARY KEY,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL,
      succeeded_at TIMESTAMP WITH TIME ZONE
    );
  `;
  assertEquals(
    queueTablesInSql([spelledOut]),
    ['verbose_queue'],
    'TIMESTAMP WITH TIME ZONE is the same type as TIMESTAMPTZ',
  );
});
