/**
 * Deno tests for sync freshness on the unified connection list. DL-1737.
 *
 * Run with:
 *   deno test supabase/functions/or-connection-list/freshness.test.ts
 *
 * WHAT IS ACTUALLY AT RISK HERE. The freshness rules themselves are pinned
 * next to the rule, in ../_shared/sync-freshness.test.ts. What this file
 * guards is different and easier to get wrong: adding a field to a read
 * surface that other teams already build against, without moving anything
 * else on the way past.
 *
 * So the central assertion is subtractive rather than additive. Strip the
 * three new keys off each returned row and what is left must deep-equal the
 * input exactly. A test that only checked "sync_freshness is present and
 * correct" would pass while `status` was quietly rewritten underneath it, and
 * `status` is the field every consumer switches on.
 *
 * Both families go through the real projections, `stealthRowToConnection` and
 * `tagRegularConnection`, not through hand-built objects. If a projection
 * stops producing the field the decorator reads, that must fail here rather
 * than in production.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { STALE_AFTER_HOURS } from '../_shared/sync-freshness.ts';
import {
  stealthRowToConnection,
  tagRegularConnection,
  withSyncFreshness,
} from './stealth-union.ts';
import type { StealthConnectionRow, UnifiedConnection } from './stealth-union.ts';

const NOW = new Date('2026-08-27T12:00:00.000Z');
const MS_PER_HOUR = 3_600_000;

/** The three keys DL-1737 adds. Nothing else in a row may change. */
const FRESHNESS_KEYS = ['sync_freshness', 'hours_since_sync', 'stale_after_hours'] as const;

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * MS_PER_HOUR).toISOString();
}

/** A regular `connections` row as index.ts builds it, before decoration. */
function regularRow(
  id: string,
  status: string,
  lastSyncAt: string | null,
): UnifiedConnection {
  return tagRegularConnection({
    id,
    provider_type: 'quiltt',
    encrypted_label: 'sealed-label',
    encrypted_credentials: 'sealed-creds',
    credentials_key_version: 1,
    status,
    last_sync_at: lastSyncAt,
    last_sync_cursor: 'cursor-abc',
    encrypted_last_error: null,
    created_at: '2026-07-01T00:00:00.000Z',
    source_wallets: [],
  }) as unknown as UnifiedConnection;
}

/** A stealth row as index.ts builds it, before decoration. */
function stealthRow(
  id: string,
  status: string,
  lastSyncAt: string | null,
): UnifiedConnection {
  const row: StealthConnectionRow = {
    id,
    connection_kind: 'xpub_stealth',
    status,
    last_sync_at: lastSyncAt,
    last_block_scanned: 912345,
    created_at: '2026-07-02T00:00:00.000Z',
  };
  return stealthRowToConnection(row);
}

/** A copy of `row` with the three new keys removed. */
function withoutFreshness(row: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...row };
  for (const key of FRESHNESS_KEYS) delete rest[key];
  return rest;
}

Deno.test('a regular row gains the three fields and nothing else changes', () => {
  const input = regularRow('conn-1', 'active', hoursAgo(1));
  const [output] = withSyncFreshness([input], NOW);

  assertEquals(output.sync_freshness, 'fresh');
  assertEquals(output.hours_since_sync, 1);
  assertEquals(output.stale_after_hours, STALE_AFTER_HOURS);
  assertEquals(
    withoutFreshness(output as unknown as Record<string, unknown>),
    input as unknown as Record<string, unknown>,
  );
});

Deno.test('a stealth row gains the three fields and nothing else changes', () => {
  const input = stealthRow('stealth-1', 'active', hoursAgo(1));
  const [output] = withSyncFreshness([input], NOW);

  assertEquals(output.sync_freshness, 'fresh');
  assertEquals(output.stale_after_hours, STALE_AFTER_HOURS);
  assertEquals(
    withoutFreshness(output as unknown as Record<string, unknown>),
    input as unknown as Record<string, unknown>,
  );
});

Deno.test('status is unchanged for every value, 28-day-stale case included', () => {
  // The connections vocabulary, plus the disconnected value a stealth
  // `archived` row maps to. Each is paired with an age that spans the whole
  // range of freshness verdicts, so no status is only ever seen fresh.
  const cases: Array<{ status: string; lastSyncAt: string | null }> = [
    { status: 'pending', lastSyncAt: null },
    { status: 'active', lastSyncAt: hoursAgo(1) },
    { status: 'active', lastSyncAt: hoursAgo(28 * 24) },
    { status: 'error', lastSyncAt: hoursAgo(73) },
    { status: 'disconnected', lastSyncAt: hoursAgo(71) },
    { status: 'partial', lastSyncAt: hoursAgo(28 * 24) },
  ];

  for (const c of cases) {
    const input = regularRow(`conn-${c.status}`, c.status, c.lastSyncAt);
    const [output] = withSyncFreshness([input], NOW);
    assertEquals(
      output.status,
      c.status,
      `status was rewritten for ${c.status} at ${c.lastSyncAt}`,
    );
    assertEquals(
      withoutFreshness(output as unknown as Record<string, unknown>),
      input as unknown as Record<string, unknown>,
      `a field other than the three new ones moved for status ${c.status}`,
    );
  }
});

Deno.test('the 28-day production case reports stale while status stays active', () => {
  // This is the exact shape that has been invisible on production: silent for
  // weeks, status active, no stored error. The point of the field is that
  // these two facts can now be told apart without changing either of them.
  const input = regularRow('conn-silent', 'active', hoursAgo(28 * 24));
  const [output] = withSyncFreshness([input], NOW);

  assertEquals(output.status, 'active');
  assertEquals(output.encrypted_last_error, null);
  assertEquals(output.sync_freshness, 'stale');
  assertEquals(output.hours_since_sync, 672);
});

Deno.test('null last_sync_at is never, on both families', () => {
  const [regular] = withSyncFreshness([regularRow('r', 'pending', null)], NOW);
  const [stealth] = withSyncFreshness([stealthRow('s', 'active', null)], NOW);

  assertEquals(regular.sync_freshness, 'never');
  assertEquals(regular.hours_since_sync, null);
  assertEquals(stealth.sync_freshness, 'never');
  assertEquals(stealth.hours_since_sync, null);
});

Deno.test('71 hours is fresh and 73 hours is stale, on both families', () => {
  const rows = withSyncFreshness(
    [
      regularRow('r-71', 'active', hoursAgo(71)),
      regularRow('r-73', 'active', hoursAgo(73)),
      stealthRow('s-71', 'active', hoursAgo(71)),
      stealthRow('s-73', 'active', hoursAgo(73)),
    ],
    NOW,
  );

  assertEquals(rows.map(r => r.sync_freshness), ['fresh', 'stale', 'fresh', 'stale']);
});

Deno.test('every row in a response carries all three fields', () => {
  // "One shape" means a consumer reads a field off ANY row and gets a value of
  // the right type. A field present on some rows and absent on others is the
  // failure this asserts against, and it is the one a spot check misses.
  const rows = withSyncFreshness(
    [
      regularRow('r-1', 'active', hoursAgo(1)),
      regularRow('r-2', 'pending', null),
      stealthRow('s-1', 'archived', hoursAgo(400)),
      stealthRow('s-2', 'error', 'not-a-date'),
    ],
    NOW,
  );

  assertEquals(rows.length, 4);
  for (const row of rows) {
    const asRecord = row as unknown as Record<string, unknown>;
    for (const key of FRESHNESS_KEYS) {
      assert(key in asRecord, `${key} missing from row ${row.id}`);
    }
    assertEquals(row.stale_after_hours, STALE_AFTER_HOURS);
    assert(
      ['never', 'fresh', 'stale'].includes(row.sync_freshness),
      `unexpected sync_freshness ${row.sync_freshness} on row ${row.id}`,
    );
  }
});

Deno.test('one call measures every row against one instant', () => {
  // Two rows stamped at the same moment must get the same verdict in the same
  // payload. If the clock were read per row this could differ under load.
  const stamp = hoursAgo(72);
  const rows = withSyncFreshness(
    [regularRow('r', 'active', stamp), stealthRow('s', 'active', stamp)],
    NOW,
  );

  assertEquals(rows[0].sync_freshness, rows[1].sync_freshness);
  assertEquals(rows[0].hours_since_sync, rows[1].hours_since_sync);
});

Deno.test('an empty list stays empty rather than throwing', () => {
  assertEquals(withSyncFreshness([], NOW), []);
});
