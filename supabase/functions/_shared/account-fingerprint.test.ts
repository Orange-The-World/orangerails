/**
 * Deno tests for computeAccountFingerprint and computeWalletFingerprint.
 *
 * Run with:
 *   deno test --allow-env supabase/functions/_shared/account-fingerprint.test.ts
 *
 * The fingerprint is a dedup key, so a collision is not cosmetic: two inputs
 * that produce the same value would make two unrelated wallets (or accounts)
 * dedup onto each other. These tests pin the things that would cause that, and
 * the return type, which is easy to get wrong because the sibling function
 * returns hex and the wallet column is BYTEA.
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

// ---------- separator invariant (synchronous -- no crypto needed) ----------

Deno.test('WALLET_DOMAIN_SEPARATOR and DOMAIN_SEPARATOR are not equal', () => {
  // Both fingerprint schemes share one HMAC key (OR_ACCT_FINGERPRINT_KEY_V1).
  // The domain separator is the only guard that keeps a wallet-scheme message
  // from being mistaken for an account-scheme message (or vice versa). Pin the
  // constants directly so this test fails the moment they are equalised, before
  // any message bytes need to be compared. The cross-scheme output test below
  // does NOT pin this invariant in isolation: when the separators differ AND
  // the field count differs, the outputs differ for two independent reasons.
  assertNotEquals(WALLET_DOMAIN_SEPARATOR, DOMAIN_SEPARATOR);
});

// ---------- wallet fingerprint ----------

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

Deno.test('wallet and account outputs differ for the same core inputs', async () => {
  // Both HMACs are computed under the same key. This confirms the outputs differ,
  // which follows from both the distinct domain separators AND the different field
  // count (5 vs 4). It does NOT pin the separator invariant in isolation -- the
  // synchronous constant test above does that.
  const wallet = await computeWalletFingerprint('sub-1', 'strike', 'acct-1', 'BTC');
  const account = await computeAccountFingerprint('sub-1', 'strike', 'acct-1');
  assertNotEquals(hex(wallet), account);
});

Deno.test('wallet: rejects a NUL byte in any field', async () => {
  // All four fields are validated. A NUL in any position makes the NUL-joined
  // message ambiguous: two different inputs can assemble identically.
  await assertRejects(
    () => computeWalletFingerprint('sub\x00bad', 'strike', 'acct-1', 'BTC'),
    Error,
    'NUL byte',
  );
  await assertRejects(
    () => computeWalletFingerprint('sub-1', 'strike\x00bad', 'acct-1', 'BTC'),
    Error,
    'NUL byte',
  );
  await assertRejects(
    () => computeWalletFingerprint('sub-1', 'strike', 'acct\x00bad', 'BTC'),
    Error,
    'NUL byte',
  );
  await assertRejects(
    () => computeWalletFingerprint('sub-1', 'strike', 'acct-1', 'BT\x00C'),
    Error,
    'NUL byte',
  );
});

Deno.test('wallet: rejects an empty field', async () => {
  await assertRejects(() => computeWalletFingerprint('', 'strike', 'acct-1', 'BTC'), Error, 'empty');
  await assertRejects(() => computeWalletFingerprint('sub-1', '', 'acct-1', 'BTC'), Error, 'empty');
  await assertRejects(() => computeWalletFingerprint('sub-1', 'strike', '', 'BTC'), Error, 'empty');
  await assertRejects(() => computeWalletFingerprint('sub-1', 'strike', 'acct-1', ''), Error, 'empty');
});

Deno.test('wallet: fails loudly when the key is missing rather than falling back', async () => {
  const previous = Deno.env.get(ENV_KEY_NAME);
  Deno.env.delete(ENV_KEY_NAME);
  try {
    await assertRejects(() => computeWalletFingerprint('sub-1', 'strike', 'acct-1', 'BTC'));
  } finally {
    if (previous !== undefined) Deno.env.set(ENV_KEY_NAME, previous);
  }
});

// ---------- account fingerprint ----------

Deno.test('account: rejects a NUL byte in any field', async () => {
  // canonical_account_key can arrive from a provider API response; all three
  // fields are validated so a NUL cannot make the account-path message
  // structurally ambiguous with any other fingerprint.
  await assertRejects(
    () => computeAccountFingerprint('sub\x00bad', 'strike', 'acct-1'),
    Error,
    'NUL byte',
  );
  await assertRejects(
    () => computeAccountFingerprint('sub-1', 'strike\x00bad', 'acct-1'),
    Error,
    'NUL byte',
  );
  await assertRejects(
    () => computeAccountFingerprint('sub-1', 'strike', 'acct\x00bad'),
    Error,
    'NUL byte',
  );
});

Deno.test('account: rejects an empty field', async () => {
  await assertRejects(() => computeAccountFingerprint('', 'strike', 'acct-1'), Error, 'empty');
  await assertRejects(() => computeAccountFingerprint('sub-1', '', 'acct-1'), Error, 'empty');
  await assertRejects(() => computeAccountFingerprint('sub-1', 'strike', ''), Error, 'empty');
});
