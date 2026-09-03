import { describe, expect, it } from 'vitest';
import { UPSERT_CHANNEL_STATE_SQL } from './index';

// Real channel_state columns, from migration
// supabase/migrations/20260711120000_channel_state.sql. There is no
// sealed_blob and no updated_at on this table: the envelope is split into
// seal_version + sealed_iv + sealed_ct, and the only timestamps are
// created_at (default now()) and closed_at (server-stamped by trigger).
const CHANNEL_STATE_COLUMNS = new Set([
  'id',
  'user_id',
  'outpoint_bidx',
  'seal_version',
  'sealed_iv',
  'sealed_ct',
  'update_id',
  'closed_at',
  'created_at',
]);

// The only unique index over this table (channel_state_user_outpoint_uidx)
// is the composite one. A bare outpoint_bidx target has no matching
// constraint and would collapse two users' channels onto one row.
const EXPECTED_CONFLICT_TARGET = '(user_id, outpoint_bidx)';

function parseInsertColumns(sql: string): string[] {
  const m = sql.match(/INSERT INTO channel_state \(([^)]+)\)/);
  if (!m) throw new Error('could not find the INSERT column list in UPSERT_CHANNEL_STATE_SQL');
  return m[1].split(',').map((c) => c.trim());
}

function parseConflictTarget(sql: string): string {
  const m = sql.match(/ON CONFLICT\s*(\([^)]+\))/);
  if (!m) throw new Error('could not find ON CONFLICT (...) in UPSERT_CHANNEL_STATE_SQL');
  return m[1];
}

function parseUpdateSetColumns(sql: string): string[] {
  const m = sql.match(/DO UPDATE\s*SET([\s\S]+?)WHERE/);
  if (!m) throw new Error('could not find the UPDATE SET list in UPSERT_CHANNEL_STATE_SQL');
  return m[1]
    .split(',')
    .map((assignment) => assignment.trim().split('=')[0].trim())
    .filter(Boolean);
}

describe('UPSERT_CHANNEL_STATE_SQL matches the live channel_state schema', () => {
  it('inserts only columns that exist on channel_state', () => {
    const cols = parseInsertColumns(UPSERT_CHANNEL_STATE_SQL);
    expect(cols.length).toBeGreaterThan(0);
    for (const col of cols) {
      expect(CHANNEL_STATE_COLUMNS.has(col)).toBe(true);
    }
  });

  it('insert list includes user_id, so the ownership gate can be enforced', () => {
    const cols = parseInsertColumns(UPSERT_CHANNEL_STATE_SQL);
    expect(cols).toContain('user_id');
  });

  it('conflict target is the real composite unique index, not the bare blind index', () => {
    expect(parseConflictTarget(UPSERT_CHANNEL_STATE_SQL)).toBe(EXPECTED_CONFLICT_TARGET);
  });

  it('does not name sealed_blob anywhere, it is not a column on channel_state', () => {
    expect(UPSERT_CHANNEL_STATE_SQL).not.toMatch(/sealed_blob/);
  });

  it('update SET list only touches columns that exist (no updated_at)', () => {
    const cols = parseUpdateSetColumns(UPSERT_CHANNEL_STATE_SQL);
    expect(cols.length).toBeGreaterThan(0);
    for (const col of cols) {
      expect(CHANNEL_STATE_COLUMNS.has(col)).toBe(true);
    }
    expect(cols).not.toContain('updated_at');
  });

  it('compare-and-set guard is inside the ON CONFLICT, keeping the row lock for the whole upsert', () => {
    expect(UPSERT_CHANNEL_STATE_SQL).toMatch(
      /WHERE\s+channel_state\.update_id\s*<\s*EXCLUDED\.update_id/,
    );
  });
});
