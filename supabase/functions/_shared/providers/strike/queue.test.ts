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
 * drainStrikeQueue requires a live SupabaseClient and a Strike API and is not
 * unit-tested here.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { strikeSubscriptionErrorMarker, resolveInvoiceWallet, detectSystemicFailure } from './queue.ts';
import { computeWalletFingerprint } from '../../account-fingerprint.ts';
import { toByteaHex } from '../../bytea.ts';

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
