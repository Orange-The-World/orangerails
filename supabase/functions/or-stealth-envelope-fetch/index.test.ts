/**
 * Test: isUuid rejects a trailing newline (OR-T1881).
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/or-stealth-envelope-fetch/index.test.ts
 *
 * Without the m flag, `$` matches at the end of the string OR immediately
 * before a final newline, so the bare regex accepts a UUID followed by
 * "\n". Goes red against the pre-fix guard, which had no length check.
 */

import { assert, assertFalse } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { isUuid } from './index.ts';

const VALID = '11111111-1111-1111-1111-111111111111';

Deno.test('isUuid accepts a canonical uuid', () => {
  assert(isUuid(VALID));
});

Deno.test('isUuid rejects the same uuid plus a trailing newline', () => {
  assertFalse(isUuid(VALID + '\n'));
});

Deno.test('isUuid rejects a non-uuid string', () => {
  assertFalse(isUuid('not-a-uuid'));
});
