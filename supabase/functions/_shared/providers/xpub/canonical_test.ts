/**
 * Canonicalization tests for the xpub adapter (SLIP-132 variants).
 *
 * Deno tests, colocated with the Deno edge function they cover. Run with:
 *   deno test supabase/functions/_shared/providers/xpub/
 *
 * The module under test imports from esm.sh, which the node test runner cannot
 * resolve, so these deliberately do not live in the frontend vitest suite.
 */

import {
  assertEquals,
  assertNotEquals,
  assertThrows,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { base58check } from 'https://esm.sh/@scure/base@1.1.7';
import { sha256 } from 'https://esm.sh/@noble/hashes@1.4.0/sha256';

import { normalizeExtendedPubkey } from './canonical.ts';

const b58check = base58check(sha256);

// SLIP-132 version bytes. The first three are supported; the last three are
// testnet and must be rejected in v1.
const VERSIONS = {
  xpub: new Uint8Array([0x04, 0x88, 0xb2, 0x1e]),
  ypub: new Uint8Array([0x04, 0x9d, 0x7c, 0xb2]),
  zpub: new Uint8Array([0x04, 0xb2, 0x47, 0x46]),
  tpub: new Uint8Array([0x04, 0x35, 0x87, 0xcf]),
  upub: new Uint8Array([0x04, 0x4a, 0x52, 0x62]),
  vpub: new Uint8Array([0x04, 0x5f, 0x1c, 0xf6]),
};

/**
 * Build a 78-byte extended key with the given version bytes. Everything after
 * the version is FIXED, so every prefix produced here encodes byte-identical
 * key material: same depth, same parent fingerprint, same child index, same
 * chain code, same public key. That is exactly the case the identity design has
 * to survive.
 *
 * normalizeExtendedPubkey never touches the curve (base58check, length and
 * version bytes only), so a synthetic body exercises every branch it has, and
 * nothing here can be mistyped the way a copied vector can.
 *
 * Layout: version[0..3] depth[4] parentFingerprint[5..8] childIndex[9..12]
 *         chainCode[13..44] key[45..77]
 */
function extendedKey(version: Uint8Array): string {
  const body = new Uint8Array(78);
  body.set(version, 0);
  body[4] = 0x03;
  body.set([0x01, 0x02, 0x03, 0x04], 5);
  body.set([0x80, 0x00, 0x00, 0x00], 9);
  for (let i = 0; i < 32; i++) body[13 + i] = i + 1;
  body[45] = 0x02;
  for (let i = 0; i < 32; i++) body[46 + i] = 0xa0 + (i % 16);
  return b58check.encode(body);
}

Deno.test('every supported SLIP-132 variant collapses to one canonical value', () => {
  const canonical = normalizeExtendedPubkey(extendedKey(VERSIONS.xpub)).canonicalXpub;

  assertEquals(normalizeExtendedPubkey(extendedKey(VERSIONS.ypub)).canonicalXpub, canonical);
  assertEquals(normalizeExtendedPubkey(extendedKey(VERSIONS.zpub)).canonicalXpub, canonical);

  // The canonical form IS the xpub-version encoding, not some third value.
  assertEquals(canonical, extendedKey(VERSIONS.xpub));
});

Deno.test('script type is recovered from the prefix, not from the canonical value', () => {
  assertEquals(normalizeExtendedPubkey(extendedKey(VERSIONS.xpub)).scriptType, 'p2pkh');
  assertEquals(normalizeExtendedPubkey(extendedKey(VERSIONS.ypub)).scriptType, 'p2sh-p2wpkh');
  assertEquals(normalizeExtendedPubkey(extendedKey(VERSIONS.zpub)).scriptType, 'p2wpkh');
});

Deno.test('COLLISION: the canonical key alone is not an account identity', () => {
  const legacy = normalizeExtendedPubkey(extendedKey(VERSIONS.xpub));
  const segwit = normalizeExtendedPubkey(extendedKey(VERSIONS.zpub));

  // Same canonical value out of two genuinely different accounts. A BIP44 wallet
  // and a BIP84 wallet over identical key bytes derive DISJOINT address sets and
  // hold DISJOINT transaction histories, and canonicalization cannot tell them
  // apart because it rewrites the one field that distinguishes them.
  assertEquals(legacy.canonicalXpub, segwit.canonicalXpub);

  // The script type is the ONLY surviving discriminator.
  assertNotEquals(legacy.scriptType, segwit.scriptType);

  // Consequence, and the reason this test exists: an account fingerprint keyed
  // on canonicalXpub alone merges these two wallets into one row and silently
  // drops an account. scriptType must be part of the fingerprint input.
});

Deno.test('canonicalization is idempotent', () => {
  const once = normalizeExtendedPubkey(extendedKey(VERSIONS.zpub)).canonicalXpub;
  const twice = normalizeExtendedPubkey(once);

  assertEquals(twice.canonicalXpub, once);
  // Re-normalizing a canonical value reads it as what it now is: an xpub.
  assertEquals(twice.scriptType, 'p2pkh');
});

Deno.test('testnet prefixes are rejected, v1 is mainnet only', () => {
  for (const prefix of ['tpub', 'upub', 'vpub'] as const) {
    assertThrows(
      () => normalizeExtendedPubkey(extendedKey(VERSIONS[prefix])),
      Error,
      'unsupported extended-pubkey prefix',
    );
  }
});

Deno.test('an unknown prefix is rejected, never coerced to mainnet', () => {
  assertThrows(
    () => normalizeExtendedPubkey('Zpub6nothingLikeAValidExtendedPublicKeyAtAll'),
    Error,
    'unsupported extended-pubkey prefix',
  );
});

Deno.test('a corrupt payload under a valid prefix is rejected', () => {
  // Right prefix, broken base58check body. Must throw rather than return a
  // half-decoded key.
  assertThrows(() => normalizeExtendedPubkey('xpub!!!!not-base58!!!!'), Error);
});

Deno.test('a malformed extended key is rejected, never normalized', () => {
  // 77 bytes instead of 78: fails the length guard or the prefix guard,
  // depending on how the short body base58-encodes. Either way it must throw
  // and must never produce a canonical value.
  const short = b58check.encode(new Uint8Array(77));
  assertThrows(() => normalizeExtendedPubkey(short), Error);
});
