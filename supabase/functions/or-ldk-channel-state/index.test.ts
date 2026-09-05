// deno test supabase/functions/or-ldk-channel-state/index.test.ts

import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { UPSERT_CHANNEL_STATE_SQL } from './index.ts';

// Regression test for OR-T1721. UPSERT_CHANNEL_STATE_SQL is a scaffold
// constant, never executed today (the handler returns 501 on every call),
// but it is exported and labelled as the verbatim persistence spec, so a
// wrong constant here is what the next implementer would wire up verbatim.
//
// This suite cannot run the statement against a live channel_state table:
// the deno-test CI job has no Postgres. It instead pins the string shape
// against the facts confirmed live on the dev project while this ticket was
// fixed (see the commit message), so the three original defects cannot
// silently return:
//   1. ON CONFLICT (outpoint_bidx) had no matching unique index.
//   2. sealed_blob is not a column; the table splits the envelope into
//      seal_version, sealed_iv and sealed_ct.
//   3. user_id was absent from the INSERT.

Deno.test('UPSERT_CHANNEL_STATE_SQL conflicts on the composite key, not the bare blind index', () => {
  assertStringIncludes(UPSERT_CHANNEL_STATE_SQL, 'ON CONFLICT (user_id, outpoint_bidx)');
  // The regression this guards: a bare conflict target on outpoint_bidx alone
  // has no matching unique index on the live table and collapses two users'
  // channels onto one row.
  assertEquals(/ON CONFLICT\s*\(\s*outpoint_bidx\s*\)/.test(UPSERT_CHANNEL_STATE_SQL), false);
});

Deno.test('UPSERT_CHANNEL_STATE_SQL writes user_id, bound as a parameter, in the INSERT', () => {
  assertStringIncludes(UPSERT_CHANNEL_STATE_SQL, 'INSERT INTO channel_state (user_id,');
  assertStringIncludes(UPSERT_CHANNEL_STATE_SQL, ':user_id');
});

Deno.test('UPSERT_CHANNEL_STATE_SQL writes the three envelope columns the live table has', () => {
  for (const col of ['seal_version', 'sealed_iv', 'sealed_ct']) {
    assertStringIncludes(UPSERT_CHANNEL_STATE_SQL, col);
  }
});

Deno.test('UPSERT_CHANNEL_STATE_SQL never references sealed_blob or updated_at, which do not exist on the table', () => {
  assertEquals(UPSERT_CHANNEL_STATE_SQL.includes('sealed_blob'), false);
  assertEquals(UPSERT_CHANNEL_STATE_SQL.includes('updated_at'), false);
});

Deno.test('UPSERT_CHANNEL_STATE_SQL keeps the compare-and-set WHERE inside the ON CONFLICT DO UPDATE', () => {
  // The atomicity property DESIGN.md 3.2 requires: the staleness check must
  // live inside the ON CONFLICT clause, not as a separate statement.
  const conflictBlock = UPSERT_CHANNEL_STATE_SQL.split('ON CONFLICT')[1] ?? '';
  assertStringIncludes(conflictBlock, 'WHERE channel_state.update_id < EXCLUDED.update_id');
  assertStringIncludes(conflictBlock, 'RETURNING update_id');
});
