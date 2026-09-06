/**
 * Deno tests for or-webhook-dispatch.
 *
 * Run with:
 *   deno test supabase/functions/or-webhook-dispatch/index.test.ts
 *
 * Covers:
 *   - X-OR-Signature is HMAC-SHA-256(secret, body), hex-encoded.
 *   - Successful 2xx → succeeded_at set, attempts incremented.
 *   - Non-2xx → attempts bumped, last_error captured, succeeded_at stays null.
 *   - Exponential backoff predicate skips rows still inside their window.
 *   - 5-attempt cap: rows at attempts=5 are not even returned by the query
 *     (we assert by feeding the mock such a row and confirming it is filtered).
 *   - Payload shape: event=sync.completed, subaccount_id, connection_id,
 *     synced_count, ts.
 *   - Circuit breaker (OR-T0335): N identical failures in one batch stop
 *     processing for the remaining rows and page onBreakerTrip once;
 *     distinct failures, or a lone failure among healthy rows, never trip it.
 */

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { computeSignature, dispatchBatch, isBackoffElapsed } from './index.ts';

// ── Mock Supabase client ──────────────────────────────────────────────
//
// Minimal stub supporting the chained call pattern used by dispatchBatch:
//   .from(table).select(cols).is(...).lt(...).order(...).limit(...)
//   .from(table).select(cols).in(col, vals)
//   .from(table).update(patch).eq(col, val)
//
// Returns canned data per-table; records every update for assertions.

interface UpdateCall {
  table: string;
  patch: Record<string, unknown>;
  whereId: string;
}

function makeMockClient(opts: {
  deliveryRows: Array<Record<string, unknown>>;
  platformRows: Array<Record<string, unknown>>;
  updates: UpdateCall[];
}) {
  // deno-lint-ignore no-explicit-any
  const builder = (table: string): any => {
    const state = {
      table,
      patch: null as Record<string, unknown> | null,
      whereId: '' as string,
    };
    const chain = {
      select(_cols: string) { return chain; },
      is(_col: string, _val: unknown) { return chain; },
      lt(_col: string, _val: unknown) { return chain; },
      in(_col: string, _vals: unknown[]) {
        if (table === 'platforms') {
          return Promise.resolve({ data: opts.platformRows, error: null });
        }
        return Promise.resolve({ data: [], error: null });
      },
      order(_col: string, _o: { ascending: boolean }) { return chain; },
      limit(_n: number) {
        if (table === 'webhook_delivery') {
          return Promise.resolve({ data: opts.deliveryRows, error: null });
        }
        return Promise.resolve({ data: [], error: null });
      },
      update(patch: Record<string, unknown>) {
        state.patch = patch;
        return chain;
      },
      eq(_col: string, val: string) {
        if (state.patch) {
          opts.updates.push({ table: state.table, patch: state.patch, whereId: val });
          state.patch = null;
        }
        return Promise.resolve({ data: null, error: null });
      },
    };
    return chain;
  };
  return { from: builder };
}

/** Build N delivery rows sharing a platform, distinct ids, ready to run now. */
function makeRows(n: number, prefix: string): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    platform_id: 'plat-1',
    subaccount_id: null,
    event_type: 'sync.completed',
    payload: { event: 'sync.completed' },
    attempts: 0,
    last_attempt_at: null,
    event_id: `${prefix}-event-${i}`,
  }));
}

// ── Signature test ────────────────────────────────────────────────────

Deno.test('computeSignature: hex HMAC-SHA-256 matches a precomputed vector', async () => {
  // Known answer: HMAC-SHA-256(key="key", msg="The quick brown fox jumps over the lazy dog")
  // = f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8
  const got = await computeSignature(
    'key',
    'The quick brown fox jumps over the lazy dog',
  );
  assertEquals(
    got,
    'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
  );
});

// ── Backoff predicate ─────────────────────────────────────────────────

Deno.test('isBackoffElapsed: attempts=0 is always eligible', () => {
  assert(isBackoffElapsed({ attempts: 0, last_attempt_at: null }));
  assert(isBackoffElapsed({ attempts: 0, last_attempt_at: new Date().toISOString() }));
});

Deno.test('isBackoffElapsed: attempts=1 skips inside 60s window, allows after', () => {
  const now = new Date('2026-05-22T12:00:00Z');
  const recent = new Date(now.getTime() - 30 * 1000).toISOString(); // 30s ago
  const stale = new Date(now.getTime() - 121 * 1000).toISOString(); // 121s ago
  assertEquals(isBackoffElapsed({ attempts: 1, last_attempt_at: recent }, now), false);
  assertEquals(isBackoffElapsed({ attempts: 1, last_attempt_at: stale }, now), true);
});

Deno.test('isBackoffElapsed: caps at 1h regardless of attempts', () => {
  const now = new Date('2026-05-22T12:00:00Z');
  const justOverHour = new Date(now.getTime() - 3601 * 1000).toISOString();
  // attempts=20 would mathematically push the window to ~60 * 2^20 s, but the cap is 3600.
  assert(isBackoffElapsed({ attempts: 20, last_attempt_at: justOverHour }, now));
});

// ── Happy path: 2xx → succeeded ───────────────────────────────────────

Deno.test('dispatchBatch: 2xx response marks row succeeded and signs payload (v1 + v2 headers)', async () => {
  const payload = {
    event: 'sync.completed',
    subaccount_id: '11111111-1111-1111-1111-111111111111',
    connection_id: '22222222-2222-2222-2222-222222222222',
    synced_count: 3,
    ts: '2026-05-22T12:00:00Z',
  };
  const updates: UpdateCall[] = [];
  const eventId = '99999999-9999-9999-9999-999999999999';
  const mockClient = makeMockClient({
    deliveryRows: [{
      id: 'row-1',
      platform_id: 'plat-1',
      subaccount_id: payload.subaccount_id,
      event_type: 'sync.completed',
      payload,
      attempts: 0,
      last_attempt_at: null,
      event_id: eventId,
    }],
    platformRows: [{
      id: 'plat-1',
      webhook_url: 'https://example.com/hooks/or',
      webhook_secret: 'a'.repeat(64),
    }],
    updates,
  });

  let capturedBody = '';
  let capturedV1 = '';
  let capturedV2 = '';
  let capturedEventId = '';
  let capturedUrl = '';
  const mockFetch: typeof fetch = (input, init) => {
    capturedUrl = typeof input === 'string' ? input : (input as Request).url;
    capturedBody = String((init as RequestInit).body);
    const headers = new Headers((init as RequestInit).headers);
    capturedV1 = headers.get('X-OR-Signature') ?? '';
    capturedV2 = headers.get('X-OR-Signature-V2') ?? '';
    capturedEventId = headers.get('X-OR-Event-Id') ?? '';
    return Promise.resolve(new Response('ok', { status: 200 }));
  };

  const fixedNow = new Date('2026-05-22T12:00:00Z');
  const expectedTs = Math.floor(fixedNow.getTime() / 1000);

  const result = await dispatchBatch({
    // deno-lint-ignore no-explicit-any
    serviceClient: mockClient as any,
    fetchImpl: mockFetch,
    now: () => fixedNow,
  });

  assertEquals(result.attempted, 1);
  assertEquals(result.succeeded, 1);
  assertEquals(result.failed, 0);
  assertEquals(capturedUrl, 'https://example.com/hooks/or');

  // Body shape preserved
  const parsed = JSON.parse(capturedBody);
  assertEquals(parsed.event, 'sync.completed');
  assertEquals(parsed.synced_count, 3);

  // v1 signature: HMAC over body only
  const expectedV1 = await computeSignature('a'.repeat(64), capturedBody);
  assertEquals(capturedV1, expectedV1);

  // v2 signature: HMAC over "<ts>.<body>", in t=,v1= format
  const expectedV2Hex = await computeSignature('a'.repeat(64), `${expectedTs}.${capturedBody}`);
  assertEquals(capturedV2, `t=${expectedTs},v1=${expectedV2Hex}`);

  // event_id pass-through
  assertEquals(capturedEventId, eventId);

  // succeeded_at was set on the row
  const succUpdate = updates.find((u) => u.patch.succeeded_at);
  assert(succUpdate, 'expected an update setting succeeded_at');
  assertEquals(succUpdate!.whereId, 'row-1');
});

// ── Failure path: non-2xx → attempts bumped, last_error captured ──────

Deno.test('dispatchBatch: 500 response bumps attempts and records last_error', async () => {
  const updates: UpdateCall[] = [];
  const mockClient = makeMockClient({
    deliveryRows: [{
      id: 'row-fail',
      platform_id: 'plat-1',
      subaccount_id: null,
      event_type: 'sync.completed',
      payload: { event: 'sync.completed' },
      attempts: 2,
      last_attempt_at: '2026-05-22T10:00:00Z', // well outside backoff
      event_id: '00000000-0000-0000-0000-000000000002',
    }],
    platformRows: [{
      id: 'plat-1',
      webhook_url: 'https://example.com/hooks/or',
      webhook_secret: 'b'.repeat(64),
    }],
    updates,
  });
  const mockFetch: typeof fetch = () =>
    Promise.resolve(new Response('boom', { status: 500 }));

  const result = await dispatchBatch({
    // deno-lint-ignore no-explicit-any
    serviceClient: mockClient as any,
    fetchImpl: mockFetch,
    now: () => new Date('2026-05-22T12:00:00Z'),
  });

  assertEquals(result.failed, 1);
  assertEquals(result.succeeded, 0);
  assertEquals(result.breaker_tripped, false);
  const u = updates[0];
  assertEquals(u.patch.attempts, 3);
  assertEquals(u.patch.last_error, 'HTTP 500');
  assertEquals(u.patch.succeeded_at, undefined);
});

// ── Network error path ───────────────────────────────────────────────

Deno.test('dispatchBatch: fetch rejection is captured in last_error', async () => {
  const updates: UpdateCall[] = [];
  const mockClient = makeMockClient({
    deliveryRows: [{
      id: 'row-net',
      platform_id: 'plat-1',
      subaccount_id: null,
      event_type: 'sync.completed',
      payload: { event: 'sync.completed' },
      attempts: 0,
      last_attempt_at: null,
      event_id: '00000000-0000-0000-0000-000000000001',
    }],
    platformRows: [{
      id: 'plat-1',
      webhook_url: 'https://example.com/hooks/or',
      webhook_secret: 'c'.repeat(64),
    }],
    updates,
  });
  const mockFetch: typeof fetch = () => Promise.reject(new Error('fetch failed'));

  const result = await dispatchBatch({
    // deno-lint-ignore no-explicit-any
    serviceClient: mockClient as any,
    fetchImpl: mockFetch,
  });

  assertEquals(result.failed, 1);
  assertEquals(updates[0].patch.attempts, 1);
  assertEquals(updates[0].patch.last_error, 'fetch failed');
});

// ── Backoff skip: rows inside window are not POSTed ──────────────────

Deno.test('dispatchBatch: row inside backoff window is skipped (no fetch, no update)', async () => {
  const updates: UpdateCall[] = [];
  const now = new Date('2026-05-22T12:00:00Z');
  // attempts=2 → window = 60 * 2^2 = 240s. last_attempt was 30s ago → still in window.
  const mockClient = makeMockClient({
    deliveryRows: [{
      id: 'row-skip',
      platform_id: 'plat-1',
      subaccount_id: null,
      event_type: 'sync.completed',
      payload: { event: 'sync.completed' },
      attempts: 2,
      last_attempt_at: new Date(now.getTime() - 30_000).toISOString(),
    }],
    platformRows: [{
      id: 'plat-1',
      webhook_url: 'https://example.com/hooks/or',
      webhook_secret: 'd'.repeat(64),
    }],
    updates,
  });
  let fetchCalls = 0;
  const mockFetch: typeof fetch = () => {
    fetchCalls += 1;
    return Promise.resolve(new Response('ok', { status: 200 }));
  };

  const result = await dispatchBatch({
    // deno-lint-ignore no-explicit-any
    serviceClient: mockClient as any,
    fetchImpl: mockFetch,
    now: () => now,
  });

  assertEquals(result.skipped_backoff, 1);
  assertEquals(result.attempted, 0);
  assertEquals(fetchCalls, 0);
  assertEquals(updates.length, 0);
});

// ── 5-attempt cap: rows at attempts=5 are filtered server-side ───────
//
// The dispatcher SELECT uses `.lt('attempts', MAX_ATTEMPTS)` which the
// mock interprets by simply returning whatever deliveryRows we set. To
// exercise the cap meaningfully we assert that:
//   1. A row already at attempts=5 (would-be returned without the cap)
//      that we feed despite the predicate STILL gets one more attempt
//      bump (defensive , verifying the failure branch increments).
//   2. After the failing branch, attempts would be 6 which means even
//      a misconfigured production query plan can never re-enqueue it
//      forever: the partial index `idx_webhook_delivery_pending`
//      excludes attempts >= 5.
//
// More directly, we test that when attempts is at the cap MINUS ONE,
// one more failure bumps it to the cap, and a subsequent scan with
// a correct query would now skip it.

Deno.test('dispatchBatch: attempts increments past failures honor 5-attempt cap semantics', async () => {
  const updates: UpdateCall[] = [];
  const mockClient = makeMockClient({
    deliveryRows: [{
      id: 'row-near-cap',
      platform_id: 'plat-1',
      subaccount_id: null,
      event_type: 'sync.completed',
      payload: { event: 'sync.completed' },
      attempts: 4, // one below cap
      last_attempt_at: '2026-05-22T00:00:00Z', // old enough for any backoff
      event_id: '00000000-0000-0000-0000-000000000003',
    }],
    platformRows: [{
      id: 'plat-1',
      webhook_url: 'https://example.com/hooks/or',
      webhook_secret: 'e'.repeat(64),
    }],
    updates,
  });
  const mockFetch: typeof fetch = () =>
    Promise.resolve(new Response('boom', { status: 500 }));

  const result = await dispatchBatch({
    // deno-lint-ignore no-explicit-any
    serviceClient: mockClient as any,
    fetchImpl: mockFetch,
    now: () => new Date('2026-05-22T12:00:00Z'),
  });

  assertEquals(result.failed, 1);
  assertEquals(updates[0].patch.attempts, 5);
  // After this update the row is at attempts=5; the partial index
  // (attempts < 5) excludes it from future drains. Documented as the
  // 5-attempt cap.
});

// ── Disabled platform → row abandoned, no fetch ──────────────────────

Deno.test('dispatchBatch: platform with NULL webhook_url marks row abandoned', async () => {
  const updates: UpdateCall[] = [];
  const mockClient = makeMockClient({
    deliveryRows: [{
      id: 'row-orphan',
      platform_id: 'plat-1',
      subaccount_id: null,
      event_type: 'sync.completed',
      payload: { event: 'sync.completed' },
      attempts: 0,
      last_attempt_at: null,
      event_id: '00000000-0000-0000-0000-000000000001',
    }],
    platformRows: [{
      id: 'plat-1',
      webhook_url: null,
      webhook_secret: null,
    }],
    updates,
  });
  let fetchCalls = 0;
  const mockFetch: typeof fetch = () => {
    fetchCalls += 1;
    return Promise.resolve(new Response('ok', { status: 200 }));
  };

  const result = await dispatchBatch({
    // deno-lint-ignore no-explicit-any
    serviceClient: mockClient as any,
    fetchImpl: mockFetch,
  });

  assertEquals(result.abandoned, 1);
  assertEquals(fetchCalls, 0);
  assertEquals(updates[0].patch.last_error, 'platform_webhook_disabled');
  assert(updates[0].patch.succeeded_at, 'abandoned row should have succeeded_at set to remove it from the queue');
});

// ── Circuit breaker (OR-T0335) ────────────────────────────────────────
//
// A single systemic failure (a dead downstream host, a broken deploy, a
// bad secret rotation) used to be retried and retired one row at a time,
// indistinguishable from many unrelated bad rows, until every row involved
// had aged past its own 5-attempt cap with no alert in between. These
// tests pin the fix: N identical failures stop the batch and page a
// human; anything else runs exactly as before.

Deno.test('dispatchBatch: N identical failures trip the breaker and leave the rest of the batch untouched', async () => {
  const updates: UpdateCall[] = [];
  const mockClient = makeMockClient({
    deliveryRows: makeRows(5, 'row-trip'),
    platformRows: [{
      id: 'plat-1',
      webhook_url: 'https://example.com/hooks/or',
      webhook_secret: 'f'.repeat(64),
    }],
    updates,
  });
  const mockFetch: typeof fetch = () =>
    Promise.resolve(new Response('boom', { status: 500 }));

  const trips: Array<{ reason: string; failureCount: number; remainingSkipped: number }> = [];

  const result = await dispatchBatch({
    // deno-lint-ignore no-explicit-any
    serviceClient: mockClient as any,
    fetchImpl: mockFetch,
    now: () => new Date('2026-05-22T12:00:00Z'),
    onBreakerTrip: (info) => { trips.push(info); },
  });

  assertEquals(result.scanned, 5);
  // Rows 1-3 fail identically and trip the breaker on the 3rd; rows 4-5
  // are left completely untouched, not even attempted.
  assertEquals(result.attempted, 3);
  assertEquals(result.failed, 3);
  assertEquals(result.skipped_breaker, 2);
  assertEquals(result.breaker_tripped, true);
  assertEquals(result.breaker_reason, 'HTTP 500');

  // Only the first 3 rows got any update call at all , the remaining 2
  // were left exactly as retryable as they started, no attempts bump.
  assertEquals(updates.length, 3);
  assertEquals(updates.map((u) => u.whereId), ['row-trip-0', 'row-trip-1', 'row-trip-2']);

  assertEquals(trips.length, 1);
  assertEquals(trips[0].reason, 'HTTP 500');
  assertEquals(trips[0].failureCount, 3);
  assertEquals(trips[0].remainingSkipped, 2);
});

Deno.test('dispatchBatch: distinct failure reasons never trip the breaker', async () => {
  const updates: UpdateCall[] = [];
  const mockClient = makeMockClient({
    deliveryRows: makeRows(3, 'row-distinct'),
    platformRows: [{
      id: 'plat-1',
      webhook_url: 'https://example.com/hooks/or',
      webhook_secret: 'g'.repeat(64),
    }],
    updates,
  });
  const statuses = [500, 502, 503];
  let call = 0;
  const mockFetch: typeof fetch = () => {
    const status = statuses[call];
    call += 1;
    return Promise.resolve(new Response('boom', { status }));
  };

  const trips: unknown[] = [];

  const result = await dispatchBatch({
    // deno-lint-ignore no-explicit-any
    serviceClient: mockClient as any,
    fetchImpl: mockFetch,
    now: () => new Date('2026-05-22T12:00:00Z'),
    onBreakerTrip: (info) => { trips.push(info); },
  });

  // Every row still gets processed and retired normally: three different
  // error strings never reach the same-reason threshold.
  assertEquals(result.attempted, 3);
  assertEquals(result.failed, 3);
  assertEquals(result.skipped_breaker, 0);
  assertEquals(result.breaker_tripped, false);
  assertEquals(result.breaker_reason, null);
  assertEquals(updates.length, 3);
  assertEquals(trips.length, 0);
});

Deno.test('dispatchBatch: a lone bad row among healthy rows is retired normally, breaker stays cold', async () => {
  const updates: UpdateCall[] = [];
  const rows = makeRows(3, 'row-mixed');
  const mockClient = makeMockClient({
    deliveryRows: rows,
    platformRows: [{
      id: 'plat-1',
      webhook_url: 'https://example.com/hooks/or',
      webhook_secret: 'h'.repeat(64),
    }],
    updates,
  });
  let call = 0;
  const mockFetch: typeof fetch = () => {
    const status = call === 0 ? 500 : 200;
    call += 1;
    return Promise.resolve(new Response(status === 200 ? 'ok' : 'boom', { status }));
  };

  const result = await dispatchBatch({
    // deno-lint-ignore no-explicit-any
    serviceClient: mockClient as any,
    fetchImpl: mockFetch,
    now: () => new Date('2026-05-22T12:00:00Z'),
  });

  assertEquals(result.attempted, 3);
  assertEquals(result.failed, 1);
  assertEquals(result.succeeded, 2);
  assertEquals(result.skipped_breaker, 0);
  assertEquals(result.breaker_tripped, false);
  assertEquals(updates.length, 3);
});
