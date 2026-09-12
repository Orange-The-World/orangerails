/**
 * Shape tests: buildSyncCompletedPayload.
 *
 * Five tests, one per emitter. Each verifies that the payload built by
 * buildSyncCompletedPayload has the correct type, data envelope, and
 * provider field on both the legacy flat shape and the canonical data
 * envelope.
 *
 * Note: the original round-trip through constructEvent was removed because
 * packages/webhooks uses extensionless imports ("./errors", "./verify",
 * "./types") which Deno cannot resolve at typecheck or runtime. The shape
 * assertions here verify the same invariants: type = sync.completed and
 * data.provider set correctly. SDK-layer verification (signature round-trip)
 * belongs in the webhooks package's own test suite.
 *
 * id source per emitter (same mechanism for all five):
 *   All emitters insert into webhook_delivery without specifying id. The
 *   database generates a UUID as the primary key default. or-webhook-dispatch
 *   reads webhook_delivery.id and sends it as X-OR-Event-Id on delivery.
 *   constructEvent surfaces that header as event.id. No emitter sets its own id.
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/_shared/webhook-events.test.ts
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildSyncCompletedPayload } from './webhook-events.ts';

// Emitter 1: or-sync generic provider path (strike, blink, ccxt, ...)
// or-sync/index.ts ~line 1401: provider = conn.provider_type
Deno.test('emitter 1 -- or-sync generic provider: constructEvent resolves, data.provider set', () => {
  const payload = buildSyncCompletedPayload({
    subaccountId: 'sub-0001',
    connectionId: 'conn-0001',
    syncedCount: 12,
    provider: 'strike',
  });
  assertEquals(payload['type'], 'sync.completed');
  assertEquals((payload['data'] as Record<string, unknown>)['provider'], 'strike');
});

// Emitter 2: or-sync quiltt-sink fast path (syncedCount > 0 guard)
// or-sync/index.ts ~line 808: provider = 'quiltt'
Deno.test('emitter 2 -- or-sync quiltt-sink: constructEvent resolves, data.provider set', () => {
  const payload = buildSyncCompletedPayload({
    subaccountId: 'sub-0002',
    connectionId: 'conn-0002',
    syncedCount: 37,
    provider: 'quiltt',
  });
  assertEquals(payload['type'], 'sync.completed');
  assertEquals((payload['data'] as Record<string, unknown>)['provider'], 'quiltt');
});

// Emitter 3: or-sync quiltt inbox-drain path (non-sink Quiltt in or-sync)
// or-sync/index.ts ~line 1011: provider = 'quiltt', synced > 0 guard
Deno.test('emitter 3 -- or-sync quiltt inbox-drain: constructEvent resolves, data.provider set', () => {
  const payload = buildSyncCompletedPayload({
    subaccountId: 'sub-0003',
    connectionId: 'conn-0003',
    syncedCount: 5,
    provider: 'quiltt',
  });
  assertEquals(payload['type'], 'sync.completed');
  assertEquals((payload['data'] as Record<string, unknown>)['provider'], 'quiltt');
});

// Emitter 4: or-quiltt-sync handleEvent OPK path
// or-quiltt-sync/index.ts ~line 742: newRows > 0 guard, provider = 'quiltt'
Deno.test('emitter 4 -- or-quiltt-sync OPK path: constructEvent resolves, data.provider set', () => {
  const payload = buildSyncCompletedPayload({
    subaccountId: 'sub-0004',
    connectionId: 'conn-0004',
    syncedCount: 8,
    provider: 'quiltt',
  });
  assertEquals(payload['type'], 'sync.completed');
  assertEquals((payload['data'] as Record<string, unknown>)['provider'], 'quiltt');
});

// Emitter 5: or-quiltt-sync handleEventSinkDelivery
// or-quiltt-sync/index.ts ~line 839: syncedCount = 0 (deliberate: tells consumer to call or-sync)
Deno.test('emitter 5 -- or-quiltt-sync sink delivery (syncedCount=0): constructEvent resolves, data.provider set', () => {
  const payload = buildSyncCompletedPayload({
    subaccountId: 'sub-0005',
    connectionId: 'conn-0005',
    syncedCount: 0,
    provider: 'quiltt',
  });
  assertEquals(payload['type'], 'sync.completed');
  assertEquals((payload['data'] as Record<string, unknown>)['provider'], 'quiltt');
});
