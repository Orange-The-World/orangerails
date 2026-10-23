/**
 * Tests: connection.errored enqueue for Quiltt error events.
 *
 * Every case where the sender must send nothing is pinned here, as well as
 * the one case where it sends: a wrong "send nothing" is a customer who is
 * never told their bank connection broke.
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/or-quiltt-sync/connection-errored.test.ts
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0';
import {
  buildConnectionErroredPayload,
  connectionErroredReason,
} from '../_shared/webhook-events.ts';
import { enqueueConnectionErrored } from './connection-errored.ts';

type Row = Record<string, unknown>;

interface Fake {
  connection?: Row | null;
  platform?: Row | null;
  recent?: Row[];
  insertError?: string;
}

// A chainable, awaitable stand-in for the few supabase-js calls the helper makes.
function fakeClient(fake: Fake) {
  const inserted: Row[] = [];
  const filters: Array<[string, string, unknown]> = [];
  const client = {
    from(table: string) {
      let isInsert = false;
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        eq: (col: string, val: unknown) => (filters.push([table, col, val]), q),
        gte: (col: string, val: unknown) => (filters.push([table, col, val]), q),
        limit: () => q,
        maybeSingle: () => q,
        insert: (row: Row) => {
          isInsert = true;
          inserted.push(row);
          return q;
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (isInsert) {
            return resolve({ data: null, error: fake.insertError ? { message: fake.insertError } : null });
          }
          if (table === 'connections') return resolve({ data: fake.connection ?? null, error: null });
          if (table === 'platforms') return resolve({ data: fake.platform ?? null, error: null });
          if (table === 'webhook_delivery') return resolve({ data: fake.recent ?? [], error: null });
          return resolve({ data: null, error: { message: `unexpected table ${table}` } });
        },
      };
      return q;
    },
  };
  return { client: client as unknown as SupabaseClient, inserted, filters };
}

const ev = (
  type = 'connection.synced.errored.repairable',
  payload: unknown = { record: { id: 'quiltt-conn-1' } },
) => ({ event_id: 'evt-1', event_type: type, payload });

const HOOK = { webhook_url: 'https://example.test/hook' };
const NOW = Date.parse('2026-10-24T12:00:00.000Z');

Deno.test('reason mapping: only the repairable subtype is repairable and the list stays closed', () => {
  const r = connectionErroredReason;
  assertEquals(r('connection.synced.errored.repairable'), { reasonCode: 'USER_ACTION_REQUIRED', repairable: true });
  assertEquals(r('connection.synced.errored.institution'), { reasonCode: 'INSTITUTION_ERROR', repairable: false });
  assertEquals(r('connection.synced.errored.provider'), { reasonCode: 'PROVIDER_ERROR', repairable: false });
  assertEquals(r('connection.synced.errored.service'), { reasonCode: 'SERVICE_ERROR', repairable: false });
  assertEquals(r('connection.synced.errored.somethingnew'), { reasonCode: 'UNKNOWN', repairable: false });
  assertEquals(r('connection.synced.errored'), { reasonCode: 'UNKNOWN', repairable: false });
});

Deno.test('payload is { type, data } with exactly the four contract fields', () => {
  const p = buildConnectionErroredPayload({
    subaccountId: 'sub-1',
    connectionId: 'or-conn-1',
    reasonCode: 'PROVIDER_ERROR',
    repairable: false,
  });
  assertEquals(p.type, 'connection.errored');
  assertEquals(Object.keys(p).sort(), ['data', 'type']);
  assertEquals(Object.keys(p.data).sort(), ['connection_id', 'reason_code', 'repairable', 'subaccount_id']);
});

Deno.test('enqueues one row carrying the OR connection id, not the Quiltt id', async () => {
  const { client, inserted } = fakeClient({ connection: { id: 'or-conn-1' }, platform: HOOK });
  const out = await enqueueConnectionErrored(client, ev(), 'plat-1', 'sub-1', () => NOW);
  assertEquals(out, 'enqueued');
  assertEquals(inserted, [{
    platform_id: 'plat-1',
    subaccount_id: 'sub-1',
    event_type: 'connection.errored',
    payload: {
      type: 'connection.errored',
      data: {
        subaccount_id: 'sub-1',
        connection_id: 'or-conn-1',
        reason_code: 'USER_ACTION_REQUIRED',
        repairable: true,
      },
    },
  }]);
});

Deno.test('sends nothing when one is already queued for the connection in the last 24 hours', async () => {
  const { client, inserted, filters } = fakeClient({
    connection: { id: 'or-conn-1' },
    platform: HOOK,
    recent: [{ id: 'delivery-1' }],
  });
  const out = await enqueueConnectionErrored(client, ev(), 'plat-1', 'sub-1', () => NOW);
  assertEquals(out, 'within-window');
  assertEquals(inserted.length, 0);
  // The look-back is exactly 24 hours and is keyed by the OR connection id.
  const has = (col: string, val: unknown) =>
    filters.some(([t, c, v]) => t === 'webhook_delivery' && c === col && v === val);
  assertEquals(has('created_at', '2026-10-23T12:00:00.000Z'), true);
  assertEquals(has('payload->data->>connection_id', 'or-conn-1'), true);
});

Deno.test('sends nothing, and reads nothing, when the event has no record.id', async () => {
  for (const payload of [{ record: null }, { record: {} }, {}, null]) {
    const { client, inserted, filters } = fakeClient({ connection: { id: 'or-conn-1' }, platform: HOOK });
    const out = await enqueueConnectionErrored(client, ev(undefined, payload), 'plat-1', 'sub-1', () => NOW);
    assertEquals(out, 'no-record-id');
    assertEquals(inserted.length, 0);
    assertEquals(filters.length, 0);
  }
});

Deno.test('sends nothing when no OR connections row matches the Quiltt connection', async () => {
  const { client, inserted } = fakeClient({ connection: null, platform: HOOK });
  assertEquals(await enqueueConnectionErrored(client, ev(), 'plat-1', 'sub-1', () => NOW), 'no-connection-row');
  assertEquals(inserted.length, 0);
});

Deno.test('sends nothing when the platform has no webhook_url', async () => {
  for (const platform of [{ webhook_url: null }, { webhook_url: '' }, null]) {
    const { client, inserted } = fakeClient({ connection: { id: 'or-conn-1' }, platform });
    assertEquals(await enqueueConnectionErrored(client, ev(), 'plat-1', 'sub-1', () => NOW), 'no-webhook-url');
    assertEquals(inserted.length, 0);
  }
});

Deno.test('an insert failure is reported as failed and not thrown', async () => {
  const { client } = fakeClient({ connection: { id: 'or-conn-1' }, platform: HOOK, insertError: 'boom' });
  assertEquals(await enqueueConnectionErrored(client, ev(), 'plat-1', 'sub-1', () => NOW), 'failed');
});

Deno.test('a client that throws is reported as failed and not thrown', async () => {
  const broken = {
    from() {
      throw new Error('boom');
    },
  } as unknown as SupabaseClient;
  assertEquals(await enqueueConnectionErrored(broken, ev(), 'plat-1', 'sub-1', () => NOW), 'failed');
});
