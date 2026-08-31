/**
 * Tests for the envelope replacement reset (ticket OR-T1203).
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/or-stealth-connection-create/envelope_replace.test.ts
 *
 * WHAT IS UNDER TEST, and why it is shaped this way.
 *
 * The rule the product promises is one line: after an envelope replacement,
 * the next sync starts at the wallet birthday. Replacing the envelope is the
 * only full rescan a user can trigger for themselves.
 *
 * That rule spans two files that deploy independently. The reset lives in the
 * edge function; the start height is decided in the browser by
 * scanStartHeight() in src/stealth/lib/ranges.ts, over the coverage map and
 * the legacy cursor. A comment in the edge function used to restate the start
 * height formula, the formula grew a third term, and the recovery path stopped
 * working with nothing going red anywhere.
 *
 * So these cases do not restate the formula either. They import the REAL
 * scanStartHeight and the REAL resumeHeightFromCoverage, run the REAL reset
 * against a small in-memory model of the two tables it writes, and ask what
 * the next sync would start at. A change to the resume rule that disarms the
 * reset again fails here.
 *
 * The fake client is deliberately state-backed rather than a call recorder: a
 * recorder can only prove which statements were issued, and the defect being
 * fixed was that the right statement was issued and the observable outcome was
 * still wrong.
 */

import {
  assert,
  assertEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  resumeHeightFromCoverage,
  scanStartHeight,
  type ScanRange,
} from '../../../src/stealth/lib/ranges.ts';
import { applyEnvelopeReplacement, isEnvelopeReplacementError } from './envelope_replace.ts';

// ── a small model of the two tables an envelope replacement writes ──────────

interface FakeConnection {
  id: string;
  sealed_envelope: unknown;
  wallet_birthday_plaintext: string | null;
  last_block_scanned: number | null;
}

interface FakeRange extends ScanRange {
  connection_id: string;
}

interface FakeDb {
  connections: FakeConnection[];
  ranges: FakeRange[];
}

interface RecordedCall {
  table: string;
  op: 'delete' | 'update';
  filters: Record<string, unknown>;
}

interface FailurePoint {
  table: string;
  op: 'delete' | 'update';
  /**
   * Which occurrence of that table and op to fail, 1-based. The reset issues
   * TWO updates against stealth_connections now (the cursor clear, then the
   * envelope), so a failure point that names only the table would break the
   * first one and a case meaning to test the second would silently test the
   * first instead. Omitted means fail every occurrence, which is what the
   * single-write cases want.
   */
  nth?: number;
}

function makeClient(db: FakeDb, failAt: FailurePoint | null = null) {
  const calls: RecordedCall[] = [];

  function query(table: string, op: 'delete' | 'update', payload?: Record<string, unknown>) {
    const filters: Record<string, unknown> = {};
    const builder = {
      eq(column: string, value: unknown) {
        filters[column] = value;
        return builder;
      },
      // supabase-js query builders are thenables; awaiting one runs it. The
      // fake matches that shape so the code under test needs no seam.
      then(resolve: (r: { error: unknown }) => void) {
        calls.push({ table, op, filters });

        const occurrence = calls.filter((c) => c.table === table && c.op === op).length;
        if (
          failAt && failAt.table === table && failAt.op === op &&
          (failAt.nth === undefined || failAt.nth === occurrence)
        ) {
          resolve({ error: { message: 'simulated database failure' } });
          return;
        }

        if (table === 'stealth_scan_ranges' && op === 'delete') {
          db.ranges = db.ranges.filter((r) => r.connection_id !== filters.connection_id);
        } else if (table === 'stealth_connections' && op === 'update') {
          for (const conn of db.connections) {
            if (conn.id === filters.id) Object.assign(conn, payload);
          }
        } else {
          // Never silently accept an unmodelled write: a fake that shrugs is
          // how a test starts proving nothing.
          throw new Error(`fake client: unmodelled ${op} on ${table}`);
        }

        resolve({ error: null });
      },
    };
    return builder;
  }

  const client = {
    from(table: string) {
      return {
        delete: () => query(table, 'delete'),
        update: (payload: Record<string, unknown>) => query(table, 'update', payload),
      };
    },
  };

  return { client, calls };
}

/**
 * What the widget would compute as the next sync's start height for this
 * connection. Mirrors src/stealth/widget/routes/sync.tsx: read the coverage
 * rows, reduce them with resumeHeightFromCoverage, hand that plus the stored
 * cursor to the start height rule.
 */
function nextSyncStartHeight(db: FakeDb, connectionId: string, birthdayHeight: number): number {
  const conn = db.connections.find((c) => c.id === connectionId);
  if (!conn) throw new Error('test setup: connection not in the model');
  const ranges: ScanRange[] = db.ranges
    .filter((r) => r.connection_id === connectionId)
    .map((r) => ({ from_height: r.from_height, to_height: r.to_height }));

  return scanStartHeight({
    birthdayHeight,
    lastBlockScanned: conn.last_block_scanned,
    resumeFromHeight: resumeHeightFromCoverage(ranges, birthdayHeight),
  });
}

const CONNECTION = '3d298aaf-629a-42bd-a8e6-b11478d5d40f';
const OTHER_CONNECTION = 'ac62a1cb-05e9-4e8e-a649-850b3f605daa';
const BIRTHDAY_HEIGHT = 910_810;
const COVERAGE_TOP = 963_896;

const OLD_ENVELOPE = { version: 1, algorithm: 'AES-GCM', iv_b64: 'old', ciphertext_b64: 'old' };
const NEW_ENVELOPE = { version: 1, algorithm: 'AES-GCM', iv_b64: 'new', ciphertext_b64: 'new' };

function dbWithCoverage(): FakeDb {
  return {
    connections: [
      {
        id: CONNECTION,
        sealed_envelope: OLD_ENVELOPE,
        wallet_birthday_plaintext: '2024-01-01',
        last_block_scanned: COVERAGE_TOP,
      },
    ],
    ranges: [
      { connection_id: CONNECTION, from_height: BIRTHDAY_HEIGHT, to_height: COVERAGE_TOP },
    ],
  };
}

// ── 1. the defect: coverage present, so the reset must clear it ─────────────

Deno.test('with coverage recorded, an envelope replacement makes the next sync start at the birthday', async () => {
  const db = dbWithCoverage();

  // PRECONDITION. Before the replacement this connection resumes at the top of
  // its recorded coverage, not at its birthday. If this ever stops holding,
  // the case below would pass for the wrong reason and prove nothing.
  assertEquals(
    nextSyncStartHeight(db, CONNECTION, BIRTHDAY_HEIGHT),
    COVERAGE_TOP,
    'precondition: a connection with coverage resumes at the top of that coverage',
  );

  const { client } = makeClient(db);
  const result = await applyEnvelopeReplacement(client, CONNECTION, {
    sealed_envelope: NEW_ENVELOPE,
    wallet_birthday_plaintext: '2023-06-01',
  });

  assertEquals(isEnvelopeReplacementError(result), false, JSON.stringify(result));
  assertEquals(
    nextSyncStartHeight(db, CONNECTION, BIRTHDAY_HEIGHT),
    BIRTHDAY_HEIGHT,
    'after an envelope replacement the next sync must start at the wallet birthday',
  );

  const conn = db.connections[0];
  assertEquals(conn.sealed_envelope, NEW_ENVELOPE);
  assertEquals(conn.wallet_birthday_plaintext, '2023-06-01');
  assertEquals(conn.last_block_scanned, null, 'the cursor is cleared as well as the coverage');
  assertEquals(db.ranges.length, 0, 'the coverage rows are gone');
});

// ── 2. the case the old path already handled, unchanged ────────────────────

Deno.test('with no coverage recorded, behaviour is what it was before ranges existed', async () => {
  const db: FakeDb = {
    connections: [
      {
        id: CONNECTION,
        sealed_envelope: OLD_ENVELOPE,
        wallet_birthday_plaintext: '2024-01-01',
        last_block_scanned: COVERAGE_TOP,
      },
    ],
    ranges: [],
  };

  assertEquals(
    nextSyncStartHeight(db, CONNECTION, BIRTHDAY_HEIGHT),
    COVERAGE_TOP + 1,
    'precondition: with no coverage the legacy cursor decides, one block past it',
  );

  const { client, calls } = makeClient(db);
  const result = await applyEnvelopeReplacement(client, CONNECTION, {
    sealed_envelope: NEW_ENVELOPE,
    wallet_birthday_plaintext: '2024-01-01',
  });

  assertEquals(isEnvelopeReplacementError(result), false, JSON.stringify(result));
  assertEquals(
    nextSyncStartHeight(db, CONNECTION, BIRTHDAY_HEIGHT),
    BIRTHDAY_HEIGHT,
    'clearing the cursor alone was always enough here, and still is',
  );
  assert(
    calls.some((c) => c.table === 'stealth_scan_ranges' && c.op === 'delete'),
    'the coverage clear is issued unconditionally: a no-op delete costs nothing and a ' +
      'conditional one would need a read that can be stale',
  );
});

// ── 3. a finding, not a fix: the birthday move the coverage map handled ────

Deno.test('a birthday moved below every recorded range already resumed at the birthday', async () => {
  const db = dbWithCoverage();
  const EARLIER_BIRTHDAY = 800_000;

  // No recorded range contains this height, so resumeHeightFromRanges declines
  // to skip ahead and the scan starts at the birthday. This half of the
  // recovery path was never broken, and the fix does not change it. Pinned so
  // the change is not later read as wider than it was.
  assertEquals(
    nextSyncStartHeight(db, CONNECTION, EARLIER_BIRTHDAY),
    EARLIER_BIRTHDAY,
    'coverage that does not cover the new birthday must not move the start height',
  );

  const { client } = makeClient(db);
  await applyEnvelopeReplacement(client, CONNECTION, {
    sealed_envelope: NEW_ENVELOPE,
    wallet_birthday_plaintext: '2021-01-01',
  });

  assertEquals(nextSyncStartHeight(db, CONNECTION, EARLIER_BIRTHDAY), EARLIER_BIRTHDAY);
});

// ── 4. scoping: one connection's reset touches no other connection ─────────

Deno.test('the coverage clear is scoped to the connection being replaced', async () => {
  const db = dbWithCoverage();
  db.connections.push({
    id: OTHER_CONNECTION,
    sealed_envelope: OLD_ENVELOPE,
    wallet_birthday_plaintext: '2024-01-01',
    last_block_scanned: COVERAGE_TOP,
  });
  db.ranges.push({
    connection_id: OTHER_CONNECTION,
    from_height: BIRTHDAY_HEIGHT,
    to_height: COVERAGE_TOP,
  });

  const { client, calls } = makeClient(db);
  await applyEnvelopeReplacement(client, CONNECTION, {
    sealed_envelope: NEW_ENVELOPE,
    wallet_birthday_plaintext: '2023-06-01',
  });

  assertEquals(db.ranges.length, 1);
  assertEquals(db.ranges[0].connection_id, OTHER_CONNECTION);
  assertEquals(db.connections[1].last_block_scanned, COVERAGE_TOP, 'the other connection is untouched');

  const deleteCall = calls.find((c) => c.table === 'stealth_scan_ranges');
  assert(deleteCall, 'no delete was issued against the coverage table');
  assertEquals(deleteCall?.filters.connection_id, CONNECTION);
});

// ── 5. failure is reported, and fails on the safe side ────────────────────

Deno.test('a failed coverage clear reports an error and does not replace the envelope', async () => {
  const db = dbWithCoverage();
  const { client } = makeClient(db, { table: 'stealth_scan_ranges', op: 'delete' });

  const result = await applyEnvelopeReplacement(client, CONNECTION, {
    sealed_envelope: NEW_ENVELOPE,
    wallet_birthday_plaintext: '2023-06-01',
  });

  assert(isEnvelopeReplacementError(result), 'a failed coverage clear must not answer ok');
  assertEquals(isEnvelopeReplacementError(result) ? result.status : 0, 500);
  assertEquals(
    db.connections[0].sealed_envelope,
    OLD_ENVELOPE,
    'the envelope must not be replaced when the coverage could not be cleared, or the ' +
      'user would hold a new envelope with stale coverage and no rescan',
  );
  assertEquals(db.ranges.length, 1);

  // The cursor clear landed before the delete was attempted, so the residual
  // state is a null cursor behind intact coverage. That arm can only return
  // the birthday or a to_height that was genuinely scanned, so it cannot skip
  // a block: losing the cursor is the harmless half by construction.
  assertEquals(db.connections[0].last_block_scanned, null);
  assertEquals(
    nextSyncStartHeight(db, CONNECTION, BIRTHDAY_HEIGHT),
    COVERAGE_TOP,
    'the coverage arm answers, at a height this connection really did scan',
  );
});

// ── 6. OR-T1242: an absent birthday must not be collapsed with an explicit null ──

Deno.test('wallet_birthday_plaintext OMITTED from the request preserves the stored birthday', async () => {
  const db = dbWithCoverage();
  const { client } = makeClient(db);

  // No wallet_birthday_plaintext key at all -- exactly what a re-add that
  // only means to swap the envelope looks like, and the shape an external
  // platform-mode caller's request could take without this repo being able
  // to see or pin its code.
  const result = await applyEnvelopeReplacement(client, CONNECTION, {
    sealed_envelope: NEW_ENVELOPE,
    wallet_birthday_plaintext: undefined,
  });

  assertEquals(isEnvelopeReplacementError(result), false, JSON.stringify(result));
  assertEquals(
    db.connections[0].wallet_birthday_plaintext,
    '2024-01-01',
    'omitting the field must not overwrite the previously stored birthday',
  );
  assertEquals(db.connections[0].sealed_envelope, NEW_ENVELOPE, 'the envelope still replaces');
  assertEquals(db.connections[0].last_block_scanned, null, 'the cursor still resets');
  assertEquals(db.ranges.length, 0, 'coverage still clears');
});

Deno.test('wallet_birthday_plaintext sent as an explicit null still clears it (widget behaviour, unchanged)', async () => {
  const db = dbWithCoverage();
  const { client } = makeClient(db);

  // Mirrors what src/stealth/widget/routes/add.tsx always sends: the key is
  // present, the value is null, because under ZKA the birthday lives only
  // inside the sealed envelope for a widget-mode connection.
  const result = await applyEnvelopeReplacement(client, CONNECTION, {
    sealed_envelope: NEW_ENVELOPE,
    wallet_birthday_plaintext: null,
  });

  assertEquals(isEnvelopeReplacementError(result), false, JSON.stringify(result));
  assertEquals(
    db.connections[0].wallet_birthday_plaintext,
    null,
    'an explicit null must still clear a previously stored birthday',
  );
});

Deno.test('a failed envelope write reports an error and leaves the connection rescanning from the birthday', async () => {
  const db = dbWithCoverage();
  // The SECOND update against stealth_connections is the envelope. The first
  // is the cursor clear, and it must be allowed to land for this to be the
  // half applied state at all.
  const { client } = makeClient(db, { table: 'stealth_connections', op: 'update', nth: 2 });

  const result = await applyEnvelopeReplacement(client, CONNECTION, {
    sealed_envelope: NEW_ENVELOPE,
    wallet_birthday_plaintext: '2023-06-01',
  });

  assert(isEnvelopeReplacementError(result), 'a failed envelope write must not answer ok');
  assertEquals(db.ranges.length, 0, 'the cursor clear and the coverage delete both landed');
  assertEquals(db.connections[0].sealed_envelope, OLD_ENVELOPE, 'only the envelope write was lost');
  assertEquals(db.connections[0].last_block_scanned, null, 'the cursor was cleared first');

  // Neither arm can point past the birthday now, so the residual state is the
  // old envelope rescanning from the old birthday: slow, and correct. That is
  // the promise the module header has always made, and before OR-T1256 it was
  // not kept, because the cursor rode along in the write that failed and so
  // survived at COVERAGE_TOP.
  assertEquals(nextSyncStartHeight(db, CONNECTION, BIRTHDAY_HEIGHT), BIRTHDAY_HEIGHT);
});

// ── 7. OR-T1256: the half applied reset must not step over an unscanned gap ──

const GAP_BIRTHDAY = 700_000;
const GAP_RANGE_FROM = 800_000;
const GAP_RANGE_TO = 850_000;

/**
 * A connection with a real hole in its coverage: it has read 800000 to 850000
 * and nothing between its birthday at 700000 and 799999. This is the shape
 * that makes the write order matter, because it is the shape where the cursor
 * and the coverage map disagree about what has been read.
 */
function dbWithUnscannedGap(): FakeDb {
  return {
    connections: [
      {
        id: CONNECTION,
        sealed_envelope: OLD_ENVELOPE,
        wallet_birthday_plaintext: '2024-01-01',
        last_block_scanned: GAP_RANGE_TO,
      },
    ],
    ranges: [
      { connection_id: CONNECTION, from_height: GAP_RANGE_FROM, to_height: GAP_RANGE_TO },
    ],
  };
}

Deno.test('the cursor is cleared before the coverage rows are deleted', async () => {
  const db = dbWithUnscannedGap();
  const { client, calls } = makeClient(db);

  await applyEnvelopeReplacement(client, CONNECTION, {
    sealed_envelope: NEW_ENVELOPE,
    wallet_birthday_plaintext: '2021-01-01',
  });

  const cursorClear = calls.findIndex((c) => c.table === 'stealth_connections' && c.op === 'update');
  const coverageClear = calls.findIndex((c) => c.table === 'stealth_scan_ranges' && c.op === 'delete');
  assert(cursorClear >= 0, 'no update was issued against the connection row');
  assert(coverageClear >= 0, 'no delete was issued against the coverage table');
  assert(
    cursorClear < coverageClear,
    'a lost cursor can never cause a skip and a lost coverage row can, so the cursor ' +
      'clear must be issued first. The case below is what a reorder costs.',
  );
});

Deno.test('a half applied reset over an unscanned gap starts at the birthday, not one past the old cursor', async () => {
  const db = dbWithUnscannedGap();

  // PRECONDITION, and the whole point of the case: before the reset this
  // connection heals itself. No recorded range contains the birthday, so the
  // coverage arm declines to skip ahead and the next sync re-reads the hole.
  assertEquals(
    nextSyncStartHeight(db, CONNECTION, GAP_BIRTHDAY),
    GAP_BIRTHDAY,
    'precondition: coverage that does not reach the birthday leaves the gap self healing',
  );

  // Fail the LAST write. The cursor clear and the coverage delete have both
  // landed by then, which is exactly the half applied state.
  const { client } = makeClient(db, { table: 'stealth_connections', op: 'update', nth: 2 });
  const result = await applyEnvelopeReplacement(client, CONNECTION, {
    sealed_envelope: NEW_ENVELOPE,
    wallet_birthday_plaintext: '2021-01-01',
  });

  assert(isEnvelopeReplacementError(result), 'a failed envelope write must not answer ok');
  assertEquals(db.ranges.length, 0, 'the coverage delete landed');
  assertEquals(db.connections[0].sealed_envelope, OLD_ENVELOPE, 'the envelope write did not');
  assertEquals(db.connections[0].last_block_scanned, null, 'the cursor was cleared first');

  assertEquals(
    nextSyncStartHeight(db, CONNECTION, GAP_BIRTHDAY),
    GAP_BIRTHDAY,
    'the half applied reset must start at the wallet birthday and not at the old cursor ' +
      'plus one. Under the previous write order this returned 850001, the old cursor ' +
      'plus one, '
      'and 700000 to 799999 was then invisible to every future sync, permanently, with ' +
      'no error and nothing the user could see.',
  );
});
