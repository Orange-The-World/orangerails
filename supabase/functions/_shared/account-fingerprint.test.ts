/**
 * Deno tests for computeWalletFingerprint.
 *
 * Run with:
 *   deno test --allow-env supabase/functions/_shared/account-fingerprint.test.ts
 *
 * The fingerprint is a dedup key, so a collision is not cosmetic: two inputs
 * that produce the same value would make two unrelated wallets dedup onto each
 * other. These tests pin the things that would cause that, and the return type,
 * which is easy to get wrong because the sibling function returns hex and this
 * column is BYTEA.
 */

import { assert, assertEquals, assertNotEquals, assertRejects } from
  'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  computeAccountFingerprint,
  computeWalletFingerprint,
  DOMAIN_SEPARATOR,
  WALLET_DOMAIN_SEPARATOR,
} from './account-fingerprint.ts';

const ENV_KEY_NAME = 'OR_ACCT_FINGERPRINT_KEY_V1';
Deno.env.set(ENV_KEY_NAME, 'test-key-not-a-real-secret');

const hex = (bytes: Uint8Array) =>
  Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');

Deno.test('returns raw bytes, not hex: 32 bytes of HMAC-SHA256 output', async () => {
  // The trap this pins: source_wallets.wallet_fingerprint is BYTEA, while
  // connections.account_fingerprint is text. Returning the 64-char hex string
  // here would store 64 ASCII bytes where 32 real ones belong.
  const fp = await computeWalletFingerprint('sub-1', 'strike', 'acct-1', 'BTC');
  assert(fp instanceof Uint8Array, 'must return a Uint8Array, not a string');
  assertEquals(fp.length, 32, 'HMAC-SHA256 is 32 raw bytes');
});

Deno.test('is deterministic for the same inputs', async () => {
  const a = await computeWalletFingerprint('sub-1', 'strike', 'acct-1', 'BTC');
  const b = await computeWalletFingerprint('sub-1', 'strike', 'acct-1', 'BTC');
  assertEquals(hex(a), hex(b), 'a reconnect must reproduce the fingerprint exactly');
});

Deno.test('currency changes the fingerprint', async () => {
  // Strike exposes one wallet per currency under a single account key. Drop
  // currency and every currency under one account collapses onto one value.
  const btc = await computeWalletFingerprint('sub-1', 'strike', 'acct-1', 'BTC');
  const usd = await computeWalletFingerprint('sub-1', 'strike', 'acct-1', 'USD');
  assertNotEquals(hex(btc), hex(usd));
});

Deno.test('subaccount scopes the fingerprint', async () => {
  const a = await computeWalletFingerprint('sub-a', 'strike', 'acct-1', 'BTC');
  const b = await computeWalletFingerprint('sub-b', 'strike', 'acct-1', 'BTC');
  assertNotEquals(hex(a), hex(b), 'one provider account under two subaccounts must not correlate');
});

Deno.test('provider type changes the fingerprint', async () => {
  const a = await computeWalletFingerprint('sub-1', 'strike', 'acct-1', 'BTC');
  const b = await computeWalletFingerprint('sub-1', 'blink', 'acct-1', 'BTC');
  assertNotEquals(hex(a), hex(b));
});

Deno.test('account key changes the fingerprint', async () => {
  const a = await computeWalletFingerprint('sub-1', 'strike', 'acct-1', 'BTC');
  const b = await computeWalletFingerprint('sub-1', 'strike', 'acct-2', 'BTC');
  assertNotEquals(hex(a), hex(b));
});

Deno.test('NUL separation makes field splits unambiguous', async () => {
  // Without a separator, ('ab','c') and ('a','bc') both concatenate to 'abc'.
  // The separator is what stops two different accounts colliding onto one key.
  const first = await computeWalletFingerprint('sub-1', 'strike', 'ab', 'c');
  const second = await computeWalletFingerprint('sub-1', 'strike', 'a', 'bc');
  assertNotEquals(hex(first), hex(second));
});

Deno.test('the wallet domain separator keeps it distinct from the account scheme', async () => {
  // The two schemes share the same HMAC key. The domain separator string is
  // the only structural guarantee that a wallet fingerprint can never equal an
  // account fingerprint for the same fields. Assert the separator strings are
  // unequal directly: that is the invariant this test exists to pin. The HMAC
  // comparison below confirms it propagates to output, but comparing HMAC
  // outputs alone would pass even if the separators were made equal (the field
  // counts differ), so the string check here is the real guard.
  assertNotEquals(WALLET_DOMAIN_SEPARATOR, DOMAIN_SEPARATOR);
  const wallet = await computeWalletFingerprint('sub-1', 'strike', 'acct-1', 'BTC');
  const account = await computeAccountFingerprint('sub-1', 'strike', 'acct-1');
  assertNotEquals(hex(wallet), account);
});

Deno.test('rejects a NUL byte inside a field', async () => {
  // All four data fields are validated before signing: a NUL in any field
  // would make the NUL-join split ambiguous, letting two different input
  // tuples assemble into byte-identical messages.
  await assertRejects(
    () => computeWalletFingerprint('sub\x001', 'strike', 'acct-1', 'BTC'),
    Error,
    'NUL byte',
  );
  await assertRejects(
    () => computeWalletFingerprint('sub-1', 'str\x00ike', 'acct-1', 'BTC'),
    Error,
    'NUL byte',
  );
  await assertRejects(
    () => computeWalletFingerprint('sub-1', 'strike', 'acct\x00strike', 'BTC'),
    Error,
    'NUL byte',
  );
  await assertRejects(
    () => computeWalletFingerprint('sub-1', 'strike', 'acct-1', 'BT\x00C'),
    Error,
    'NUL byte',
  );
});

Deno.test('rejects an empty field', async () => {
  await assertRejects(() => computeWalletFingerprint('', 'strike', 'acct-1', 'BTC'), Error, 'empty');
  await assertRejects(() => computeWalletFingerprint('sub-1', '', 'acct-1', 'BTC'), Error, 'empty');
  await assertRejects(() => computeWalletFingerprint('sub-1', 'strike', '', 'BTC'), Error, 'empty');
  await assertRejects(() => computeWalletFingerprint('sub-1', 'strike', 'acct-1', ''), Error, 'empty');
});

Deno.test('fails loudly when the key is missing rather than falling back', async () => {
  const previous = Deno.env.get(ENV_KEY_NAME);
  Deno.env.delete(ENV_KEY_NAME);
  try {
    await assertRejects(() => computeWalletFingerprint('sub-1', 'strike', 'acct-1', 'BTC'));
  } finally {
    if (previous !== undefined) Deno.env.set(ENV_KEY_NAME, previous);
  }
});
