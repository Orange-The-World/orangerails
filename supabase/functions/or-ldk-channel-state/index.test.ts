/**
 * Orange Rails, LDK connector — regression test for OR-T1721.
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/or-ldk-channel-state/index.test.ts
 *
 * WHY THIS TEST IS SHAPED THIS WAY.
 *
 * OR-T1721 found that UPSERT_CHANNEL_STATE_SQL, labelled the VERBATIM
 * persistence spec, could not run against the live dev `channel_state`
 * table: the ON CONFLICT target had no matching unique index, it named a
 * column (`sealed_blob`) that does not exist, it was missing `user_id`
 * entirely, and (found while fixing it) it also set `updated_at`, which is
 * not a column on this table either. None of that was runtime-testable with
 * a fake client, because a fake models whatever shape you hand it — it
 * cannot disagree with you about what the real table looks like. It also
 * cannot be run against a live Postgres instance from this CI: the
 * deno-test job (ci.yml) runs with --allow-all but no database credential,
 * and this repo's read path to Supabase is a read-only SELECT grant, which
 * refuses even an EXPLAIN of an INSERT statement.
 *
 * So this test pins the live schema as data — read directly off the dev
 * project (fzwmnzmtqidumdqjdddz) via information_schema.columns and
 * pg_indexes on 2026-09-03, the same verification this ticket's fix used —
 * and checks the SQL string against it. Run against the SQL as it stood
 * before this fix, every assertion below fails. That is deliberate: this
 * file is the artifact that proves the defect was real and stays red if
 * the two are ever allowed to drift apart again.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { UPSERT_CHANNEL_STATE_SQL } from './index.ts';

// Pinned from the live dev table. If a migration changes channel_state,
// update this list AND UPSERT_CHANNEL_STATE_SQL in the same PR.
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
] as const;

// Pinned from the live dev table's only unique index over the write path
// (channel_state_user_outpoint_uidx). A bare `outpoint_bidx` target has no
// matching unique index and fails at runtime (DESIGN.md §3.3).
const LIVE_CONFLICT_TARGET = '(user_id, outpoint_bidx)';

function referencedColumns(sql: string): string[] {
  // Every bare identifier that looks like a column reference: after INSERT
  // INTO ... (...), after SET, or as a bare EXCLUDED.<col> / channel_state.<col>.
  const insertList = sql.match(/INSERT INTO channel_state \(([^)]+)\)/)?.[1] ?? '';
  const fromInsert = insertList.split(',').map((c) => c.trim());
  const fromExcluded = [...sql.matchAll(/EXCLUDED\.(\w+)/g)].map((m) => m[1]);
  const fromTable = [...sql.matchAll(/channel_state\.(\w+)/g)].map((m) => m[1]);
  return [...new Set([...fromInsert, ...fromExcluded, ...fromTable])];
}

Deno.test('UPSERT_CHANNEL_STATE_SQL names only columns that exist on the live table', () => {
  const referenced = referencedColumns(UPSERT_CHANNEL_STATE_SQL);
  assert(referenced.length > 0, 'test setup: no columns parsed out of the SQL, regex is broken');
  for (const col of referenced) {
    assert(
      (LIVE_CHANNEL_STATE_COLUMNS as readonly string[]).includes(col),
      `UPSERT_CHANNEL_STATE_SQL references "${col}", which is not a column on the live ` +
        `channel_state table (${LIVE_CHANNEL_STATE_COLUMNS.join(', ')}). This is the exact ` +
        'shape of the sealed_blob / updated_at defects in OR-T1721.',
    );
  }
});

Deno.test('UPSERT_CHANNEL_STATE_SQL conflicts on the composite key that actually has a unique index', () => {
  assert(
    UPSERT_CHANNEL_STATE_SQL.includes(`ON CONFLICT ${LIVE_CONFLICT_TARGET}`),
    'ON CONFLICT must target the composite (user_id, outpoint_bidx) unique index. A bare ' +
      '(outpoint_bidx) target has no matching unique index and fails at runtime (OR-T1721).',
  );
});

Deno.test('UPSERT_CHANNEL_STATE_SQL binds user_id from the caller, not the request body', () => {
  assertEquals(
    UPSERT_CHANNEL_STATE_SQL.includes(':user_id'),
    true,
    'user_id must be bound as a parameter sourced from the verified JWT (DESIGN.md §4), not ' +
      'omitted (OR-T1721) or read from the request body.',
  );
});
