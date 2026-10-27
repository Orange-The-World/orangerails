/**
 * Tests for isValidWidgetToken.
 *
 * Run with:
 *   deno test supabase/functions/or-quiltt-link-status/index.test.ts
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { isValidWidgetToken } from './index.ts';

Deno.test('a well-formed uuid is valid', () => {
  assertEquals(isValidWidgetToken('123e4567-e89b-12d3-a456-426614174000'), true);
  assertEquals(isValidWidgetToken('123E4567-E89B-12D3-A456-426614174000'), true);
});

Deno.test('absent is not valid, callers must omit the field instead', () => {
  assertEquals(isValidWidgetToken(undefined), false);
  assertEquals(isValidWidgetToken(null), false);
});

Deno.test('malformed shapes are rejected, not just non-uuid strings', () => {
  for (const junk of ['', 'not-a-uuid', '123e4567e89b12d3a456426614174000', 42, {}, [], true]) {
    assertEquals(isValidWidgetToken(junk), false);
  }
});

Deno.test('a uuid with the wrong segment lengths is rejected', () => {
  // One character short in the last segment. A regex-vs-real-parser gap
  // here is exactly what would let a malformed token reach Postgres and
  // surface as a 500 instead of a 400.
  assertEquals(isValidWidgetToken('123e4567-e89b-12d3-a456-42661417400'), false);
});
