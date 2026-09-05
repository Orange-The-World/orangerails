/**
 * Deno tests for or-stealth-connection-list. DL-1737.
 *
 * Run with:
 *   deno test supabase/functions/or-stealth-connection-list/index.test.ts
 *
 * These exercise the exported `toListedConnection`, which is the projection
 * the handler itself calls. That matters: a test that rebuilt the mapping
 * would agree with its own copy of any bug and prove nothing about what the
 * endpoint actually returns.
 *
 * The freshness RULES are pinned in ../_shared/sync-freshness.test.ts. What
 * this file guards is that the rules reach this endpoint unchanged, that the
 * seven pre-existing keys are untouched on the way past, and that the two
 * list endpoints cannot drift into disagreeing about the same timestamp.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { STALE_AFTER_HOURS } from '../_shared/sync-freshness.ts';
import { withSyncFreshness } from '../or-connection-list/stealth-union.ts';
import { stealthRowToConnection } from '../or-connection-list/stealth-union.ts';
import { toListedConnection } from './index.ts';

const NOW = new Date('2026-08-27T12:00:00.000Z');
const MS_PER_HOUR = 3_600_000;

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * MS_PER_HOUR).toISOString();
}

/** A `stealth_connections` row exactly as the select above returns it. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sc-1',
    app_slug: 'demo-app',
    connection_kind: 'xpub_stealth',
    last_sync_at: hoursAgo(1),
    last_block_scanned: 912345,
    status: 'active',
    created_at: '2026-07-02T00:00:00.000Z',
    ...overrides,
  };
}

Deno.test('the projection carries the seven original keys through untouched', () => {
  const input = row();
  const output = toListedConnection(input, NOW);

  assertEquals(output.connection_id, 'sc-1');
  assertEquals(output.app_slug, 'demo-app');
  assertEquals(output.connection_kind, 'xpub_stealth');
  assertEquals(output.last_sync_at, input.last_sync_at);
  assertEquals(output.last_block_scanned, 912345);
  assertEquals(output.status, 'active');
  assertEquals(output.created_at, '2026-07-02T00:00:00.000Z');
});

Deno.test('the projection adds exactly the three freshness keys', () => {
  const output = toListedConnection(row(), NOW);
  assertEquals(
    Object.keys(output).sort(),
    [
      'app_slug',
      'connection_id',
      'connection_kind',
      'created_at',
      'hours_since_sync',
      'last_block_scanned',
      'last_sync_at',
      'stale_after_hours',
      'status',
      'sync_freshness',
    ],
  );
});

Deno.test('never, fresh at 71 hours, stale at 73 hours', () => {
  assertEquals(
    toListedConnection(row({ last_sync_at: null }), NOW).sync_freshness,
    'never',
  );
  assertEquals(
    toListedConnection(row({ last_sync_at: hoursAgo(71) }), NOW).sync_freshness,
    'fresh',
  );
  assertEquals(
    toListedConnection(row({ last_sync_at: hoursAgo(73) }), NOW).sync_freshness,
    'stale',
  );
});

Deno.test('never reports no hours, rather than zero', () => {
  // Zero would read as a sync that just happened. Null is the honest answer
  // to "how long since the last sync" when there has not been one.
  const output = toListedConnection(row({ last_sync_at: null }), NOW);
  assertEquals(output.hours_since_sync, null);
  assertEquals(output.stale_after_hours, STALE_AFTER_HOURS);
});

Deno.test('status is unchanged for every stealth status, stale case included', () => {
  for (const status of ['active', 'error', 'archived']) {
    for (const age of [1, 71, 73, 28 * 24]) {
      const output = toListedConnection(
        row({ status, last_sync_at: hoursAgo(age) }),
        NOW,
      );
      assertEquals(
        output.status,
        status,
        `status ${status} was rewritten at ${age}h`,
      );
    }
  }
});

Deno.test('a 28-day-silent connection is stale while its status stays active', () => {
  const output = toListedConnection(
    row({ status: 'active', last_sync_at: hoursAgo(28 * 24) }),
    NOW,
  );
  assertEquals(output.status, 'active');
  assertEquals(output.sync_freshness, 'stale');
  assertEquals(output.hours_since_sync, 672);
});

Deno.test('both list endpoints give the same verdict for the same timestamp', () => {
  // The failure this guards is the worst outcome available here: one surface
  // calling a connection fresh while the other calls it stale. Both must reach
  // the same answer for the same stamp, at every interesting age, because the
  // rule and the threshold come from one shared module.
  for (const age of [0, 1, 71, 72, 73, 28 * 24]) {
    const stamp = hoursAgo(age);

    const stealthListed = toListedConnection(row({ last_sync_at: stamp }), NOW);
    const [unified] = withSyncFreshness(
      [
        stealthRowToConnection({
          id: 'sc-1',
          connection_kind: 'xpub_stealth',
          status: 'active',
          last_sync_at: stamp,
          last_block_scanned: 912345,
          created_at: '2026-07-02T00:00:00.000Z',
        }),
      ],
      NOW,
    );

    assertEquals(
      stealthListed.sync_freshness,
      unified.sync_freshness,
      `endpoints disagree at ${age}h`,
    );
    assertEquals(stealthListed.hours_since_sync, unified.hours_since_sync);
    assertEquals(stealthListed.stale_after_hours, unified.stale_after_hours);
  }
});
