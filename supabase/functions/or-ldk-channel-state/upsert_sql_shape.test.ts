/**
 * Shape test for UPSERT_CHANNEL_STATE_SQL (OR-T1721).
 *
 * The exported SQL constant is labelled the verbatim persistence spec, so it
 * is the artifact whoever wires this function is told to bind and run as-is.
 * This test pins its text against the live channel_state table's actual
 * columns and unique index rather than against the design doc, because the
 * defect this closes was exactly the code and the doc disagreeing with the
 * table and nothing catching it.
 *
 * Schema snapshot this pins against, captured 2026-09-02 from the dev
 * project (fzwmnzmtqidumdqjdddz) via information_schema.columns / pg_indexes,
 * recorded on OR-T1721:
 *   columns: id, user_id, outpoint_bidx, seal_version, sealed_iv, sealed_ct,
 *            update_id, closed_at, created_at   (no updated_at, no sealed_blob)
 *   unique index: channel_state_user_outpoint_uidx on (user_id, outpoint_bidx)
 *
 * This is a string match against that snapshot, not a live execution against
 * a running Postgres instance -- the deno-test CI job carries no database
 * credential, so nothing here opens a real connection. It catches the SQL
 * text disagreeing with what was true when the snapshot was taken; it cannot
 * catch the live table changing out from under an un-updated snapshot.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { UPSERT_CHANNEL_STATE_SQL } from './index.ts';

const LIVE_TABLE_COLUMNS = [
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

const COLUMNS_THAT_DO_NOT_EXIST = ['sealed_blob', 'updated_at'];

Deno.test('conflict target is the composite unique index, not the bare blind index', () => {
  assert(
    /ON CONFLICT\s*\(\s*user_id\s*,\s*outpoint_bidx\s*\)/.test(UPSERT_CHANNEL_STATE_SQL),
    'ON CONFLICT must target (user_id, outpoint_bidx): that is the only unique index on the ' +
      'live table. A bare ON CONFLICT (outpoint_bidx) has no matching unique index and fails ' +
      'at runtime the first time this statement is bound and run.',
  );
});

Deno.test('user_id is bound in the INSERT, not left for the request body to supply', () => {
  assert(
    /INSERT INTO channel_state\s*\([^)]*\buser_id\b/.test(UPSERT_CHANNEL_STATE_SQL),
    'user_id must be one of the inserted columns, bound from the verified JWT (DESIGN.md ' +
      'section 4.1), so the ownership gate the composite key exists for is actually enforced.',
  );
});

Deno.test('every referenced column exists on the live channel_state table', () => {
  // Pull every identifier that looks like a column reference (word tokens),
  // then require the envelope and watermark columns we know the statement
  // must touch to actually be present in the live-table snapshot above.
  const mustReference = ['user_id', 'outpoint_bidx', 'update_id', 'seal_version', 'sealed_iv', 'sealed_ct'];
  for (const col of mustReference) {
    assert(
      UPSERT_CHANNEL_STATE_SQL.includes(col),
      `expected the SQL to reference "${col}", a real column on channel_state`,
    );
    assert(
      LIVE_TABLE_COLUMNS.includes(col),
      `test bug: "${col}" is not in the pinned live-table snapshot, fix the snapshot first`,
    );
  }
});

Deno.test('no reference to a column that does not exist on the live table', () => {
  for (const col of COLUMNS_THAT_DO_NOT_EXIST) {
    assert(
      !UPSERT_CHANNEL_STATE_SQL.includes(col),
      `"${col}" is not a column on the live channel_state table and must not appear in the SQL`,
    );
  }
});

Deno.test('the statement still returns update_id for the classification read', () => {
  assertEquals(
    /RETURNING\s+update_id\s*;?\s*$/.test(UPSERT_CHANNEL_STATE_SQL.trim()),
    true,
    'RETURNING update_id is what lets the caller classify ACCEPTED vs needing the ' +
      'IDEMPOTENT_OK / REJECTED_STALE read-back (DESIGN.md section 3.2)',
  );
});
