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

Deno.test('listProviderManifests: server-side adapter without connectUrl emits no connectUrl key', () => {
  // xpub is a server-side adapter with no connectUrl declared (yet; PR 2
  // will set it to /connect/bitcoin). Guards against a spread pattern that
  // would emit { connectUrl: undefined } on every server-side manifest
  // entry -- the key must be absent entirely, not present-and-undefined.
  const manifests = listProviderManifests();
  const xpub = manifests.find(m => m.slug === 'xpub');
  const hasKey = xpub !== undefined && 'connectUrl' in xpub;
  assertEquals(
    hasKey,
    false,
    'xpub manifest must not have a connectUrl key before the adapter declares it',
  );
});

// NOTE: The third regression case -- a server-side adapter WITH connectUrl
// declared flows through to its manifest entry -- is covered in PR 2 (sets
// xpub.connectUrl = '/connect/bitcoin') where the above test is updated to
// assert xpub?.connectUrl === '/connect/bitcoin'.
