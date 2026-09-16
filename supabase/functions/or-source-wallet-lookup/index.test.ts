/**
 * Tests for or-source-wallet-lookup's source_wallet_id validation (OR-T1144).
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/or-source-wallet-lookup/index.test.ts
 *
 * UUID_RE has no end-of-string anchor problem of its own kind: JavaScript's
 * `$` matches at the end of the string OR immediately before a final
 * newline, so a regex-only check would accept a UUID with a trailing "\n".
 * The UUID_LENGTH === 36 guard beside it closes that gap. What was NOT
 * covered before this file existed (confirmed via gh_get_file 404 on this
 * path, 2026-09-14) is that the HTTP layer actually enforces it: a green
 * predicate test proves the pattern is exact, not that a caller sending a
 * trailing-newline id receives a real 400. validateSourceWalletIdOrResponse
 * IS the code path the handler calls, unchanged, so driving it here and
 * asserting on its Response is asserting on the real status a caller gets.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { validateSourceWalletIdOrResponse } from './index.ts';

const VALID_UUID = '11111111-2222-4333-8444-555555555555';

Deno.test('a source_wallet_id with a trailing newline is rejected with HTTP 400', async () => {
  const res = validateSourceWalletIdOrResponse({ source_wallet_id: VALID_UUID + '\n' }, {});
  assert(res !== null, 'a trailing-newline uuid must be rejected, not silently accepted');
  assertEquals(res!.status, 400);
  const payload = await res!.json();
  assertEquals(payload.error, 'source_wallet_id must be a UUID');
});

Deno.test('a well-formed source_wallet_id is accepted (null, no 400)', () => {
  assertEquals(validateSourceWalletIdOrResponse({ source_wallet_id: VALID_UUID }, {}), null);
});

Deno.test('a missing source_wallet_id is rejected with HTTP 400', async () => {
  const res = validateSourceWalletIdOrResponse({}, {});
  assert(res !== null);
  assertEquals(res!.status, 400);
  const payload = await res!.json();
  assertEquals(payload.error, 'source_wallet_id required');
});

Deno.test('an empty-string source_wallet_id is rejected with HTTP 400', () => {
  const res = validateSourceWalletIdOrResponse({ source_wallet_id: '' }, {});
  assert(res !== null);
  assertEquals(res!.status, 400);
});

Deno.test('a non-uuid string is rejected with HTTP 400', () => {
  const res = validateSourceWalletIdOrResponse({ source_wallet_id: 'not-a-uuid' }, {});
  assert(res !== null);
  assertEquals(res!.status, 400);
});

Deno.test('a uuid missing one trailing character is rejected with HTTP 400 (length guard)', () => {
  const res = validateSourceWalletIdOrResponse(
    { source_wallet_id: VALID_UUID.slice(0, -1) },
    {},
  );
  assert(res !== null);
  assertEquals(res!.status, 400);
});
