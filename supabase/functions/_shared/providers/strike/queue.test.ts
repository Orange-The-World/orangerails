/**
 * Deno tests for strikeSubscriptionErrorMarker: proves every Strike
 * subscription-create failure branch maps to a distinct, actionable plaintext
 * marker. Before this, only the 403/scope branch persisted a marker and every
 * other failure console.error'd into the void, leaving the connection with no
 * readable cause. These cases force each branch (bad scope, bad key, rejected
 * callback, rate limit, generic 500) using the real error-string shape that
 * strikePost throws (`Strike <status> POST /subscriptions: <detail>`).
 *
 * Run with:
 *   deno test supabase/functions/_shared/providers/strike/queue.test.ts
 */
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { strikeSubscriptionErrorMarker } from './queue.ts';

Deno.test('403 / insufficient permissions -> scope marker (unchanged, backward compatible)', () => {
  assertEquals(
    strikeSubscriptionErrorMarker('Strike 403 POST /subscriptions: Insufficient permissions'),
    'STRIKE_SCOPE_MISSING_partner.webhooks.manage',
  );
  assertEquals(
    strikeSubscriptionErrorMarker('FORBIDDEN: partner.webhooks.manage required'),
    'STRIKE_SCOPE_MISSING_partner.webhooks.manage',
  );
});

Deno.test('401 / unauthorized -> invalid key', () => {
  assertEquals(
    strikeSubscriptionErrorMarker('Strike 401 POST /subscriptions: Unauthorized'),
    'STRIKE_KEY_INVALID',
  );
});

Deno.test('400 / bad request (rejected callback url) -> subscription rejected', () => {
  assertEquals(
    strikeSubscriptionErrorMarker('Strike 400 POST /subscriptions: Bad Request, invalid webhookUrl'),
    'STRIKE_SUBSCRIPTION_REJECTED',
  );
});

Deno.test('429 / rate limited -> rate limited', () => {
  assertEquals(
    strikeSubscriptionErrorMarker('Strike 429 POST /subscriptions: rate limit exceeded'),
    'STRIKE_RATE_LIMITED',
  );
});

Deno.test('500 / generic upstream error -> generic subscription failed', () => {
  assertEquals(
    strikeSubscriptionErrorMarker('Strike 500 POST /subscriptions: Internal Server Error'),
    'STRIKE_SUBSCRIPTION_FAILED',
  );
});

Deno.test('non-http error (network / thrown Error) -> generic subscription failed', () => {
  assertEquals(
    strikeSubscriptionErrorMarker('TypeError: error sending request for url'),
    'STRIKE_SUBSCRIPTION_FAILED',
  );
});

Deno.test('every branch yields a distinct, non-empty marker (no silent-void failures)', () => {
  const markers = [
    'Strike 403 POST /subscriptions: Insufficient permissions',
    'Strike 401 POST /subscriptions: Unauthorized',
    'Strike 400 POST /subscriptions: Bad Request',
    'Strike 429 POST /subscriptions: rate limit',
    'Strike 500 POST /subscriptions: Internal Server Error',
  ].map(strikeSubscriptionErrorMarker);
  assertEquals(new Set(markers).size, 5, 'all five failure classes map to distinct markers');
  for (const m of markers) assertEquals(m.length > 0, true, 'no branch returns an empty marker');
});
