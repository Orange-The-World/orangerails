/**
 * Deno tests for the wallet-fingerprint half of account-fingerprint.ts.
 *
 * Run with:
 *   deno test --allow-env supabase/functions/_shared/account-fingerprint.test.ts
 *
 * Two things are worth pinning here, and they are the reasons this code exists.
 *
 * The message assembly is a dedup key, so a collision is not cosmetic: two
 * different accounts that assemble to the same bytes would MAC to the same
 * fingerprint and dedup onto each other, silently merging two people's wallets.
 * The field order, the domain separator, and the NUL separation are therefore
 * pinned exactly, including the ambiguity case a missing separator would allow.
 *
 * The MAC stub must never hand back a value. K_v does not exist yet, and the
 * one genuinely unrecoverable mistake would be writing a fake or env-derived
 * fingerprint to the database: it would be deduped against, and it would still
 * be wrong after the real key landed. So both the unprovisioned and provisioned
 * paths are proven to reject.
 */

import { assert, assertEquals, assertRejects, assertThrows } from
  'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  isWalletFingerprintKeyProvisioned,
  KmsKeyNotProvisionedError,
  KmsNotWiredError,
  kmsGenerateMac,
  walletFingerprintMessage,
} from './account-fingerprint.ts';

const KMS_KEY_ID_ENV = 'OR_WALLET_FINGERPRINT_KMS_KEY_ID';

function withKeyId<T>(value: string | null, fn: () => T): T {
  const previous = Deno.env.get(KMS_KEY_ID_ENV);
  if (value === null) Deno.env.delete(KMS_KEY_ID_ENV);
  else Deno.env.set(KMS_KEY_ID_ENV, value);
  try {
    return fn();
  } finally {
    if (previous === undefined) Deno.env.delete(KMS_KEY_ID_ENV);
    else Deno.env.set(KMS_KEY_ID_ENV, previous);
  }
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

Deno.test('walletFingerprintMessage: domain separator leads, then the four fields in order', () => {
  const message = decode(walletFingerprintMessage('sub-1', 'strike', 'acct-key-1', 'BTC'));
  assertEquals(message, 'orangerails/acct/v1\x00sub-1\x00strike\x00acct-key-1\x00BTC');
});

Deno.test('walletFingerprintMessage: currency is part of the message', () => {
  // Strike emits one wallet per currency under a single account key. Drop
  // currency from the message and every currency under one account collapses to
  // the same fingerprint, so they would dedup onto each other.
  const btc = decode(walletFingerprintMessage('sub-1', 'strike', 'acct-key-1', 'BTC'));
  const usd = decode(walletFingerprintMessage('sub-1', 'strike', 'acct-key-1', 'USD'));
  assert(btc !== usd, 'BTC and USD under one account must not assemble identically');
});

Deno.test('walletFingerprintMessage: subaccount scopes the message', () => {
  const a = decode(walletFingerprintMessage('sub-a', 'strike', 'acct-key-1', 'BTC'));
  const b = decode(walletFingerprintMessage('sub-b', 'strike', 'acct-key-1', 'BTC'));
  assert(a !== b, 'the same provider account under two subaccounts must not correlate');
});

Deno.test('walletFingerprintMessage: NUL separation makes field splits unambiguous', () => {
  // Without a separator, ('ab','c') and ('a','bc') both concatenate to 'abc'.
  // The separator is what stops two different accounts colliding onto one key.
  const first = decode(walletFingerprintMessage('sub-1', 'strike', 'ab', 'c'));
  const second = decode(walletFingerprintMessage('sub-1', 'strike', 'a', 'bc'));
  assert(first !== second, 'different field splits must not assemble to the same message');
});

Deno.test('walletFingerprintMessage: rejects a NUL byte inside a field', () => {
  // account_key and currency arrive from a provider API response, so the fields
  // are validated rather than assumed well-formed. A NUL byte would make the
  // field split ambiguous, so the requirement is to reject it, not encode it.
  assertThrows(
    () => walletFingerprintMessage('sub-1', 'strike', 'acct\x00strike', 'BTC'),
    Error,
    'NUL byte',
  );
});

Deno.test('walletFingerprintMessage: rejects an empty field', () => {
  assertThrows(() => walletFingerprintMessage('', 'strike', 'acct-1', 'BTC'), Error, 'empty');
  assertThrows(() => walletFingerprintMessage('sub-1', '', 'acct-1', 'BTC'), Error, 'empty');
  assertThrows(() => walletFingerprintMessage('sub-1', 'strike', '', 'BTC'), Error, 'empty');
  assertThrows(() => walletFingerprintMessage('sub-1', 'strike', 'acct-1', ''), Error, 'empty');
});

Deno.test('isWalletFingerprintKeyProvisioned: false unless the KMS key id is set', () => {
  assertEquals(withKeyId(null, isWalletFingerprintKeyProvisioned), false);
  assertEquals(withKeyId('', isWalletFingerprintKeyProvisioned), false);
  assertEquals(withKeyId('projects/or/keys/k-v', isWalletFingerprintKeyProvisioned), true);
});

Deno.test('kmsGenerateMac: rejects when K_v is not provisioned', async () => {
  const message = walletFingerprintMessage('sub-1', 'strike', 'acct-1', 'BTC');
  await withKeyId(null, () =>
    assertRejects(() => kmsGenerateMac(message), KmsKeyNotProvisionedError));
});

Deno.test('kmsGenerateMac: rejects even when K_v is named, because the KMS is not wired', async () => {
  const message = walletFingerprintMessage('sub-1', 'strike', 'acct-1', 'BTC');
  await withKeyId('projects/or/keys/k-v', () =>
    assertRejects(() => kmsGenerateMac(message), KmsNotWiredError));
});

Deno.test('kmsGenerateMac: never returns a MAC on any path', async () => {
  // The invariant that matters most while K_v is a founder gate: there is no
  // env var, no key id, and no message that makes this hand back a fingerprint.
  const message = walletFingerprintMessage('sub-1', 'strike', 'acct-1', 'BTC');
  for (const keyId of [null, '', 'projects/or/keys/k-v', 'anything-at-all']) {
    const returned = await withKeyId(keyId, async () => {
      try {
        return await kmsGenerateMac(message);
      } catch {
        return null;
      }
    });
    assertEquals(returned, null, `kmsGenerateMac returned a MAC with key id ${keyId}`);
  }
});
