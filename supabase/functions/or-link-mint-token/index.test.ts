/**
 * Tests for the mint TTL clamp.
 *
 * Run with:
 *   deno test supabase/functions/or-link-mint-token/index.test.ts
 *
 * Scope. resolveTtlSeconds is pure, so every case here runs offline with no
 * request, no platform key and no database. The insert path around it is not
 * covered: it needs a real pending_widget_sessions row and belongs with the
 * integration tests.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { resolveTtlSeconds } from './index.ts';

const DEFAULT = 300;
const MAX = 300;

Deno.test('absent ttl falls back to the default', () => {
  assertEquals(resolveTtlSeconds(undefined), DEFAULT);
  assertEquals(resolveTtlSeconds(null), DEFAULT);
});

Deno.test('a value inside the range is honoured', () => {
  assertEquals(resolveTtlSeconds(1), 1);
  assertEquals(resolveTtlSeconds(60), 60);
  assertEquals(resolveTtlSeconds(299), 299);
  assertEquals(resolveTtlSeconds(300), 300);
});

Deno.test('the ceiling is 300, not the old 900', () => {
  // This is the whole point of the change. 900 used to be honoured in full.
  assertEquals(resolveTtlSeconds(900), MAX);
  assertEquals(resolveTtlSeconds(901), MAX);
  assertEquals(resolveTtlSeconds(86_400), MAX);
  assertEquals(resolveTtlSeconds(Number.MAX_SAFE_INTEGER), MAX);
});

Deno.test('an over-large request is clamped, never rejected', () => {
  // Clamping rather than 400ing is deliberate: it is what the function did
  // before, so lowering the ceiling cannot turn a working caller into an
  // error. Asserting a number comes back is the guarantee.
  const out = resolveTtlSeconds(900);
  assertEquals(typeof out, 'number');
  assertEquals(out <= MAX, true);
});

Deno.test('junk falls back to the default rather than throwing', () => {
  for (const junk of ['300', {}, [], true, NaN, Infinity, -Infinity]) {
    assertEquals(resolveTtlSeconds(junk), DEFAULT);
  }
});

Deno.test('zero and negatives fall back to the default', () => {
  // A zero or negative TTL would mint an already-expired session, which reads
  // to a caller as "the token never worked".
  assertEquals(resolveTtlSeconds(0), DEFAULT);
  assertEquals(resolveTtlSeconds(-1), DEFAULT);
  assertEquals(resolveTtlSeconds(-900), DEFAULT);
});

Deno.test('a fractional value inside the range is left alone', () => {
  // Observed dev rows sit at ~299.96s, so fractions are real traffic, not a
  // hypothetical. They are within range and must not be mangled.
  assertEquals(resolveTtlSeconds(299.96), 299.96);
});
