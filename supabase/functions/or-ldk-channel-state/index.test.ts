/**
 * Pins UPSERT_CHANNEL_STATE_SQL (or-ldk-channel-state) to the live
 * channel_state schema. OR-T1721: the scaffold SQL named a sealed_blob
 * column that does not exist, conflicted on a column with no matching
 * unique index, set an updated_at column the table does not have, and
 * never bound user_id at all. None of that would have failed a type
 * check, because the constant is a template string, not a typed query --
 * so this test is the only thing that would have caught it.
 *
 * The column list below is not aspirational: it was read live off the
 * dev project (fzwmnzmtqidumdqjdddz) on 2026-09-05 via
 *   select column_name from information_schema.columns
 *   where table_name = 'channel_state' order by ordinal_position;
 * If this table's real columns change, update this list to match what
 * is actually live, not the other way around (DESIGN.md 3.3: this
 * function ships zero DDL, the table is the source of truth).
 *
 * Run with: deno test --no-check supabase/functions/or-ldk-channel-state/
 */

import { assert, assertEquals, assertMatch } from 'https://deno.land/std/testing/asserts.ts';
import { UPSERT_CHANNEL_STATE_SQL } from './index.ts';

const LIVE_CHANNEL_STATE_COLUMNS = [
  'id',
  'user_id',
  'outpoint_bidx',
  'seal_version',
  'sealed_iv',
  'sealed_ct',
  'update_id',
  'closed_at',
  'created_at',
];

Deno.test('OR-T1721: UPSERT_CHANNEL_STATE_SQL conflicts on the composite key that actually has a unique index', () => {
  assertMatch(UPSERT_CHANNEL_STATE_SQL, /ON CONFLICT \(user_id, outpoint_bidx\)/);
  // The bare single-column form has no matching unique index on the live
  // table and would collapse two users' channels onto one row.
  assert(
    !/ON CONFLICT \(outpoint_bidx\)/.test(UPSERT_CHANNEL_STATE_SQL),
    'must not regress to the single-column conflict target',
  );
});

Deno.test('OR-T1721: UPSERT_CHANNEL_STATE_SQL names only columns that exist on channel_state', () => {
  const insertMatch = UPSERT_CHANNEL_STATE_SQL.match(/INSERT INTO channel_state \(([^)]+)\)/);
  assert(insertMatch, 'expected an INSERT INTO channel_state (...) clause');
  const namedColumns = insertMatch![1].split(',').map((c) => c.trim());
  for (const col of namedColumns) {
    assert(
      LIVE_CHANNEL_STATE_COLUMNS.includes(col),
      `INSERT names column "${col}" which is not on the live channel_state table`,
    );
  }
  // The three-column sealed envelope must all be present, not the
  // single sealed_blob the scaffold used to write.
  assertEquals(namedColumns.includes('seal_version'), true);
  assertEquals(namedColumns.includes('sealed_iv'), true);
  assertEquals(namedColumns.includes('sealed_ct'), true);
  assert(
    !namedColumns.includes('sealed_blob'),
    'sealed_blob is not a real column on channel_state',
  );
  assert(
    namedColumns.includes('user_id'),
    'user_id must be bound in the INSERT, not left out as the scaffold did',
  );
});

Deno.test('OR-T1721: UPSERT_CHANNEL_STATE_SQL does not reference a column the table does not have', () => {
  assert(
    !/updated_at/.test(UPSERT_CHANNEL_STATE_SQL),
    'channel_state has no updated_at column',
  );
});

Deno.test('OR-T1721: UPSERT_CHANNEL_STATE_SQL binds :user_id from the caller, never trusting the request body for it', () => {
  assertMatch(UPSERT_CHANNEL_STATE_SQL, /:user_id/);
});
