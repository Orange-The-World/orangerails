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
import { strikeSubscriptionErrorMarker, resolveInvoiceWallet } from './queue.ts';
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

Deno.test('resolveInvoiceWallet: currency is case-sensitive -- btc does not match BTC', async () => {
  // This is the currency-symmetry gate. The writer (or-link-complete) stores
  // wallet_fingerprint using discovery_sessions.currency. The drain
  // (or-sync/index.ts) passes inv.amount.currency after .toUpperCase()
  // normalization before calling resolveInvoiceWallet. If that normalization
  // is ever dropped, the fingerprint will not match and the transaction is
  // held unattributed rather than mis-filed. This test pins the contract:
  // callers must normalize currency before passing it here.
  const map = await makeMap('sub-1', 'recv-1', 'BTC', 'wallet-abc');
  const result = await resolveInvoiceWallet('sub-1', 'strike', 'recv-1', 'btc', map);
  assertEquals(result, null, 'fingerprint built with "btc" must not match one built with "BTC"');
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
