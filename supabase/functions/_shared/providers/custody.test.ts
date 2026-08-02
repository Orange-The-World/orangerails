/**
 * Tests for the typed custody field on ProviderAdapter and the
 * resolveCustody() runtime helper (issue #471).
 *
 * These tests are designed to go RED before the custody field is added to an
 * adapter and GREEN after. They do not import adapter implementations directly
 * (to avoid pulling in Deno/fetch dependencies in CI); instead they exercise
 * resolveCustody() with plain objects that mirror the adapter shape.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { resolveCustody } from './types.ts';

// ---------------------------------------------------------------------------
// Happy path: recognises valid custody values
// ---------------------------------------------------------------------------

Deno.test('resolveCustody: custodial value passes through', () => {
  assertEquals(resolveCustody({ custody: 'custodial' }), 'custodial');
});

Deno.test('resolveCustody: self_custody value passes through', () => {
  assertEquals(resolveCustody({ custody: 'self_custody' }), 'self_custody');
});

// ---------------------------------------------------------------------------
// Fail-closed: absent or unrecognised value resolves to 'custodial'
//
// This is the RED/GREEN test the issue requires.
// Before fix: an adapter object with no custody field would have been
//   classified as 'self_custody' (or silently undefined) by any tag-matching
//   logic. After fix: resolveCustody always returns 'custodial' and logs.
// ---------------------------------------------------------------------------

Deno.test('resolveCustody: absent custody field fails closed to custodial', () => {
  // Simulate a stripped adapter -- exactly what you get if you delete the
  // field from a known adapter to verify the before/after behaviour.
  const strippedAdapter: { custody?: unknown } = {};
  assertEquals(resolveCustody(strippedAdapter), 'custodial');
});

Deno.test('resolveCustody: unrecognised custody string fails closed to custodial', () => {
  assertEquals(resolveCustody({ custody: 'unknown_value' }), 'custodial');
});
