/**
 * Unit tests for Strike queue drain helpers.
 *
 * Run with:
 *   deno test --allow-env supabase/functions/_shared/providers/strike/queue.test.ts
 *
 * Covers the two pure / side-effect-free exports:
 *   - strikeSubscriptionErrorMarker  (no I/O, maps an error string to a marker)
 *   - resolveInvoiceWallet           (async, but only calls crypto + a Map lookup)
 *
 * drainStrikeQueue as a whole still needs a live SupabaseClient and a Strike
 * API for its provider-facing branches (invoice/payment/etc lookups) and is
 * not fully exercised here. Its mark-processed database-write failure path
 * (OR-T0335) IS covered below: routing every fixture event through the
 * unrecognized-event_type branch never calls the Strike API, so that one
 * write can be driven with a minimal fake SupabaseClient.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  strikeSubscriptionErrorMarker,
  resolveInvoiceWallet,
  detectSystemicFailure,
  drainStrikeQueue,
  SYSTEMIC_FAILURE_THRESHOLD,
  type DrainConnection,
} from './queue.ts';
import { computeWalletFingerprint } from '../../account-fingerprint.ts';
import { toByteaHex } from '../../bytea.ts';

// ---------- drainStrikeQueue: mark-processed write failure trips the breaker ----------
//
// OR-T0335's incident was "one bad database write failed systemically" --
// the drain marking a whole batch processed in one .update() call, not a
// per-event Strike API error. That write is the only I/O in drainStrikeQueue
// that does not require a live Strike API: giving every fixture event an
// unrecognized event_type routes it through the "unknown, log + skip + mark
// processed" branch, which calls no Strike function at all. That lets the
// mark-processed path be exercised with a minimal fake client instead of a
// live SupabaseClient + Strike API, which is what the file header above says
// this function otherwise needs.

// deno-lint-ignore no-explicit-any
function fakeStrikeEventsClient(events: any[], markError: { message: string } | null): any {
  return {
    // deno-lint-ignore no-explicit-any
    from(table: string): any {
      if (table !== 'strike_webhook_events') {
        throw new Error(`fakeStrikeEventsClient: unexpected table "${table}"`);
      }
      return {
        select() { return this; },
        eq() { return this; },
        is() { return this; },
        order() { return this; },
        limit() { return Promise.resolve({ data: events, error: null }); },
        update() { return this; },
        in() { return Promise.resolve({ error: markError }); },
      };
    },
  };
}

function fixtureEvents(n: number): { id: string; event_type: string; entity_id: string }[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `evt-${i}`,
    event_type: 'unrecognized.test-only',
    entity_id: `ent-${i}`,
  }));
}

/** A connection with a subscription checked "now", so drainStrikeQueue skips
 * both the liveness check and subscription creation and goes straight to
 * draining -- the only path this fixture needs to exercise. */
function fixtureConnection(): DrainConnection {
  return {
    id: 'conn-test-1',
    strike_subscription_id: 'sub-test-1',
    last_sync_cursor: null,
    needs_resubscribe: false,
    subscription_checked_at: new Date().toISOString(),
  };
}

Deno.test('drainStrikeQueue: mark-processed failure at threshold trips the breaker', async () => {
  const events = fixtureEvents(SYSTEMIC_FAILURE_THRESHOLD);
  const result = await drainStrikeQueue({
    serviceClient: fakeStrikeEventsClient(events, { message: 'connection terminated unexpectedly' }),
    connection: fixtureConnection(),
    credentials: { api_key: 'test-key-not-real' },
    webhookBaseUrl: 'https://example.test/or-strike-webhook',
    walletsByFingerprintHex: new Map(),
    subaccountId: 'sub-1',
  });
  assertEquals(result.breakerTripped, true);
  assertEquals(result.tripReason, 'DB_WRITE_FAILED');
});

Deno.test('drainStrikeQueue: mark-processed failure below threshold does not trip the breaker', async () => {
  const events = fixtureEvents(SYSTEMIC_FAILURE_THRESHOLD - 1);
  const result = await drainStrikeQueue({
    serviceClient: fakeStrikeEventsClient(events, { message: 'connection terminated unexpectedly' }),
    connection: fixtureConnection(),
    credentials: { api_key: 'test-key-not-real' },
    webhookBaseUrl: 'https://example.test/or-strike-webhook',
    walletsByFingerprintHex: new Map(),
    subaccountId: 'sub-1',
  });
  assertEquals(result.breakerTripped, undefined);
  assertEquals(result.tripReason, undefined);
});

Deno.test('drainStrikeQueue: mark-processed succeeds -- no breaker, no false alarm', async () => {
  const events = fixtureEvents(SYSTEMIC_FAILURE_THRESHOLD);
  const result = await drainStrikeQueue({
    serviceClient: fakeStrikeEventsClient(events, null),
    connection: fixtureConnection(),
    credentials: { api_key: 'test-key-not-real' },
    webhookBaseUrl: 'https://example.test/or-strike-webhook',
    walletsByFingerprintHex: new Map(),
    subaccountId: 'sub-1',
  });
  assertEquals(result.breakerTripped, undefined);
  assertEquals(result.transactions, []);
});

const ENV_KEY_NAME = 'OR_ACCT_FINGERPRINT_KEY_V1';
Deno.env.set(ENV_KEY_NAME, 'test-key-not-a-real-secret');

// ---------- strikeSubscriptionErrorMarker ----------

Deno.test('strikeSubscriptionErrorMarker: 403 -> scope missing', () => {
  assertEquals(
    strikeSubscriptionErrorMarker('Strike 403 POST /subscriptions: Insufficient permissions'),
    'STRIKE_SCOPE_MISSING_partner.webhooks.manage',
  );
});

Deno.test('strikeSubscriptionErrorMarker: FORBIDDEN -> scope missing', () => {
  assertEquals(
    strikeSubscriptionErrorMarker('FORBIDDEN: partner.webhooks.manage required'),
    'STRIKE_SCOPE_MISSING_partner.webhooks.manage',
  );
});

Deno.test('strikeSubscriptionErrorMarker: 401 -> key invalid', () => {
  assertEquals(
    strikeSubscriptionErrorMarker('Strike 401 Unauthorized'),
    'STRIKE_KEY_INVALID',
  );
});

Deno.test('strikeSubscriptionErrorMarker: 400 -> subscription rejected', () => {
  assertEquals(
    strikeSubscriptionErrorMarker('Strike 400 Bad Request'),
    'STRIKE_SUBSCRIPTION_REJECTED',
  );
});

Deno.test('strikeSubscriptionErrorMarker: 429 -> rate limited', () => {
  assertEquals(
    strikeSubscriptionErrorMarker('Strike 429 rate-limit exceeded'),
    'STRIKE_RATE_LIMITED',
  );
});

Deno.test('strikeSubscriptionErrorMarker: unknown -> generic fallback', () => {
  assertEquals(
    strikeSubscriptionErrorMarker('Strike 500 Internal Server Error'),
    'STRIKE_SUBSCRIPTION_FAILED',
  );
});

// ---------- detectSystemicFailure ----------
// These tests satisfy OR-T0335 acceptance criterion: "the assertion must be
// watched going red". To see the failure: change the threshold arg from 3 to 4
// in the 'at threshold' test. Output: "Expected: "AUTH_ERROR" Actual: null".

Deno.test('detectSystemicFailure: empty map -> null', () => {
  assertEquals(detectSystemicFailure(new Map(), 3), null);
});

Deno.test('detectSystemicFailure: single reason below threshold -> null', () => {
  assertEquals(detectSystemicFailure(new Map([['AUTH_ERROR', 2]]), 3), null);
});

Deno.test('detectSystemicFailure: single reason at threshold -> returns reason', () => {
  assertEquals(detectSystemicFailure(new Map([['AUTH_ERROR', 3]]), 3), 'AUTH_ERROR');
});

Deno.test('detectSystemicFailure: multiple reasons none at threshold -> null', () => {
  const m = new Map([['AUTH_ERROR', 2], ['NETWORK_ERROR', 2]]);
  assertEquals(detectSystemicFailure(m, 3), null);
});

Deno.test('detectSystemicFailure: one reason at threshold among others -> returns it', () => {
  const m = new Map([['AUTH_ERROR', 3], ['NETWORK_ERROR', 1]]);
  assertEquals(detectSystemicFailure(m, 3), 'AUTH_ERROR');
});

// ---------- resolveInvoiceWallet ----------

/** Build a Map with a single fingerprint entry. */
async function makeMap(
  subaccountId: string,
  receiverId: string,
  currency: string,
  walletId: string,
): Promise<Map<string, string>> {
  const fp = await computeWalletFingerprint(subaccountId, 'strike', receiverId, currency);
  return new Map([[toByteaHex(fp), walletId]]);
}

Deno.test('resolveInvoiceWallet: hit -- exact match returns wallet id', async () => {
  const map = await makeMap('sub-1', 'recv-1', 'BTC', 'wallet-abc');
  const result = await resolveInvoiceWallet('sub-1', 'strike', 'recv-1', 'BTC', map);
  assertEquals(result, 'wallet-abc');
});

Deno.test('resolveInvoiceWallet: currency case does not matter -- btc matches BTC', async () => {
  // This is the currency-symmetry gate, and it used to assert the opposite.
  //
  // The writer (or-link-complete) stores wallet_fingerprint using
  // discovery_sessions.currency; the drain (or-sync/index.ts) passes
  // inv.amount.currency. If the two ever disagreed on case, the fingerprint
  // would not match and the transaction would be held unattributed. That used
  // to be every caller's job to prevent by uppercasing first, and this test
  // pinned that convention.
  //
  // computeWalletFingerprint now normalizes with .toUpperCase() itself, so
  // parity is the function's own contract rather than a rule each caller has
  // to remember. Uppercasing is idempotent and both call sites already
  // uppercased, so no stored fingerprint changed. The assertion below is
  // inverted to match: symmetry is now guaranteed, not merely expected.
  const map = await makeMap('sub-1', 'recv-1', 'BTC', 'wallet-abc');
  const result = await resolveInvoiceWallet('sub-1', 'strike', 'recv-1', 'btc', map);
  assertEquals(result, 'wallet-abc', 'currency case is normalized inside computeWalletFingerprint');
});

Deno.test('resolveInvoiceWallet: miss -- wrong receiver returns null', async () => {
  const map = await makeMap('sub-1', 'recv-1', 'BTC', 'wallet-abc');
  const result = await resolveInvoiceWallet('sub-1', 'strike', 'recv-other', 'BTC', map);
  assertEquals(result, null);
});

Deno.test('resolveInvoiceWallet: miss -- wrong currency returns null', async () => {
  const map = await makeMap('sub-1', 'recv-1', 'BTC', 'wallet-abc');
  const result = await resolveInvoiceWallet('sub-1', 'strike', 'recv-1', 'USD', map);
  assertEquals(result, null);
});

Deno.test('resolveInvoiceWallet: empty receiverId returns null without throwing', async () => {
  const map = await makeMap('sub-1', 'recv-1', 'BTC', 'wallet-abc');
  const result = await resolveInvoiceWallet('sub-1', 'strike', '', 'BTC', map);
  assertEquals(result, null);
});

Deno.test('resolveInvoiceWallet: empty currency returns null without throwing', async () => {
  const map = await makeMap('sub-1', 'recv-1', 'BTC', 'wallet-abc');
  const result = await resolveInvoiceWallet('sub-1', 'strike', 'recv-1', '', map);
  assertEquals(result, null);
});
