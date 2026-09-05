/**
 * Deno tests for _shared/providers/dispatch -- listProviderManifests
 * connectUrl plumbing (DL-0680).
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/_shared/providers/dispatch.test.ts
 */

import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { listProviderManifests, parseCredentials } from './dispatch.ts';
import type { ProviderAdapter } from './types.ts';

// ── DL-0680: connectUrl plumbing ──────────────────────────────────────────

Deno.test('listProviderManifests: sparrow manifest has no connectUrl (DL-1007)', () => {
  // sparrow's connectUrl was removed in DL-1007 because /connect/sparrow now
  // redirects to /providers, which would create a loop if the manifest pointed
  // there. ProviderPanel falls back to /connect?provider=sparrow.
  const manifests = listProviderManifests();
  const sparrow = manifests.find(m => m.slug === 'sparrow');
  assertEquals(
    sparrow?.connectUrl,
    undefined,
    'sparrow manifest must not carry connectUrl (route redirects to /providers)',
  );
});

Deno.test('listProviderManifests: xpub manifest has no connectUrl (DL-1007)', () => {
  // xpub's connectUrl was removed in DL-1007 because /connect/bitcoin now
  // redirects to /providers, which would create a loop if the manifest pointed
  // there. ProviderPanel falls back to /connect?provider=xpub.
  const manifests = listProviderManifests();
  const xpub = manifests.find(m => m.slug === 'xpub');
  assertEquals(
    xpub?.connectUrl,
    undefined,
    'xpub manifest must not carry connectUrl (route redirects to /providers)',
  );
});

// ── DEV-0274: parse failures throw a fixed message ────────────────────────

// Minimal stand-in: parseCredentials reads only `slug` on the JSON parse path,
// and using a stub keeps this test on the helper rather than on any one
// provider module.
const stubAdapter = {
  slug: 'stub',
  credentialFields: [],
} as unknown as ProviderAdapter;

Deno.test('parseCredentials: a parse failure throws a fixed message (DEV-0274)', () => {
  const err = assertThrows(
    () => parseCredentials(stubAdapter, '{"apiKey": "unterminated'),
    Error,
  ) as Error;
  assertEquals(
    err.message,
    '[stub] credentials are not valid JSON',
    'the message must be fixed: the underlying exception text must not be composed into it',
  );
});
