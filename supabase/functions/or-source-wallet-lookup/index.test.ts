/**
 * Unit tests for or-source-wallet-lookup's source_wallet_id validation
 * (OR-T1144 step 8).
 *
 * Run with:
 *   deno test supabase/functions/or-source-wallet-lookup/index.test.ts
 *
 * or-stealth-transactions-list pins its UUID_RE trailing-newline guard by
 * testing the isUuid() predicate directly (see its own index.test.ts). That
 * proves the predicate returns false; it does not prove the handler sends a
 * 400. This file pins the same guard here through validateSourceWalletId(),
 * which -- like or-stealth-envelope-update/cursor.ts's AdvanceCursorResult --
 * returns the actual HTTP status the handler forwards to jsonResponse() on
 * the invalid branch, so a test can assert the real status code rather than
 * re-deriving it from a boolean.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  validateSourceWalletId,
  isSourceWalletIdInvalid,
  UUID_LENGTH,
} from './index.ts';

const VALID_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

Deno.test('a canonical uuid is accepted', () => {
  const result = validateSourceWalletId(VALID_UUID);
  assertEquals(isSourceWalletIdInvalid(result), false);
  if (!isSourceWalletIdInvalid(result)) {
    assertEquals(result.value, VALID_UUID);
  }
});

Deno.test('a uuid followed by a trailing newline is rejected with the real HTTP status', () => {
  // This is the exact shape UUID_RE alone would accept: JavaScript's `$` also
  // matches immediately before a final "\n", so without the explicit length
  // check this string passes the regex. The handler's response, not just a
  // predicate, is what this test pins.
  const result = validateSourceWalletId(VALID_UUID + '\n');
  assertEquals(isSourceWalletIdInvalid(result), true);
  if (isSourceWalletIdInvalid(result)) {
    assertEquals(result.status, 400);
    assertEquals(result.error, 'source_wallet_id must be a UUID');
  }
});

Deno.test('a uuid followed by \\r\\n is rejected with the real HTTP status', () => {
  const result = validateSourceWalletId(VALID_UUID + '\r\n');
  assertEquals(isSourceWalletIdInvalid(result), true);
  if (isSourceWalletIdInvalid(result)) {
    assertEquals(result.status, 400);
  }
});

Deno.test('a truncated uuid is rejected with the real HTTP status', () => {
  const result = validateSourceWalletId(VALID_UUID.slice(0, UUID_LENGTH - 1));
  assertEquals(isSourceWalletIdInvalid(result), true);
  if (isSourceWalletIdInvalid(result)) {
    assertEquals(result.status, 400);
    assertEquals(result.error, 'source_wallet_id must be a UUID');
  }
});

Deno.test('a missing source_wallet_id is rejected as required, not as malformed', () => {
  const result = validateSourceWalletId(undefined);
  assertEquals(isSourceWalletIdInvalid(result), true);
  if (isSourceWalletIdInvalid(result)) {
    assertEquals(result.status, 400);
    // Distinct message from the malformed-uuid case: a caller who forgot the
    // field entirely should not be told its shape is wrong.
    assertEquals(result.error, 'source_wallet_id required');
  }
});

Deno.test('a non-string source_wallet_id is rejected as required', () => {
  const result = validateSourceWalletId(12345);
  assertEquals(isSourceWalletIdInvalid(result), true);
  if (isSourceWalletIdInvalid(result)) {
    assertEquals(result.status, 400);
    assertEquals(result.error, 'source_wallet_id required');
  }
});

Deno.test('an uppercase uuid is accepted (UUID_RE is case-insensitive)', () => {
  const result = validateSourceWalletId(VALID_UUID.toUpperCase());
  assertEquals(isSourceWalletIdInvalid(result), false);
});
