/**
 * Deno tests for _shared/providers/dispatch -- listProviderManifests
 * connectUrl plumbing (DL-0680).
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/_shared/providers/dispatch.test.ts
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { listProviderManifests } from './dispatch.ts';

// ── DL-0680: connectUrl plumbing ──────────────────────────────────────────

Deno.test('listProviderManifests: client-side manifest carries connectUrl through', () => {
  // sparrow is in CLIENT_SIDE_MANIFESTS with connectUrl: '/connect/sparrow'.
  // Guards against a regression where the field is silently dropped in the
  // merge step inside listProviderManifests().
  const manifests = listProviderManifests();
  const sparrow = manifests.find(m => m.slug === 'sparrow');
  assertEquals(
    sparrow?.connectUrl,
    '/connect/sparrow',
    'sparrow manifest must carry connectUrl through listProviderManifests',
  );
});

Deno.test('listProviderManifests: server-side adapter connectUrl flows through to manifest', () => {
  // xpub now declares connectUrl: '/connect/bitcoin'. Guards that the spread
  // inside listProviderManifests() carries it through -- the key must be
  // present with the correct value, not silently dropped.
  const manifests = listProviderManifests();
  const xpub = manifests.find(m => m.slug === 'xpub');
  assertEquals(
    xpub?.connectUrl,
    '/connect/bitcoin',
    'xpub manifest must carry connectUrl through listProviderManifests',
  );
});
