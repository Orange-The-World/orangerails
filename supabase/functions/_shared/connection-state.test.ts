/**
 * Test: isValidUuid rejects a trailing newline (OR-T1881).
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/_shared/connection-state.test.ts
 *
 * WHY THIS GOES RED WITHOUT THE FIX. JavaScript has no end-of-string anchor.
 * Without the m flag, `$` matches at the end of the string OR immediately
 * before a final newline, so a UUID pattern used alone accepts a UUID
 * followed by "\n". isValidUuid must reject that value, not just the
 * well-formed one.
 */

import { assert, assertFalse } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { isValidUuid } from './connection-state.ts';

const VALID = '11111111-1111-1111-1111-111111111111';

Deno.test('isValidUuid accepts a canonical uuid', () => {
  assert(isValidUuid(VALID));
});

Deno.test('isValidUuid rejects the same uuid plus a trailing newline', () => {
  assertFalse(isValidUuid(VALID + '\n'));
});

Deno.test('isValidUuid rejects a non-uuid string', () => {
  assertFalse(isValidUuid('not-a-uuid'));
});

Deno.test('isValidUuid rejects non-string input', () => {
  assertFalse(isValidUuid(undefined));
  assertFalse(isValidUuid(null));
  assertFalse(isValidUuid(12345));
});
