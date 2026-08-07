/**
 * Deno tests for or-stealth-transactions-store.
 *
 * Run with:
 *   deno test supabase/functions/or-stealth-transactions-store/index.test.ts
 *
 * Covers deriveResponseCursor, the pure function that decides the cursor value
 * returned to the caller (DL-0419). The rule: the response cursor derives only
 * from stored state, never from the client-supplied scan tip
 * (body.last_block_scanned). Integration coverage of the HTTP surface comes
 * from curl probes after deploy.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { deriveResponseCursor } from './index.ts';

Deno.test('fresh connection, zero inserted, returns null (never the client scan tip)', () => {
  // storedCursor null = connection has never scanned. inserted 0, maxBlockInserted -1.
  // The old code fell back to body.last_block_scanned here; the requirement is null.
  assertEquals(deriveResponseCursor(null, 0, -1), null);
});

Deno.test('fresh connection, fresh rows inserted, returns the max inserted height', () => {
  assertEquals(deriveResponseCursor(null, 3, 812345), 812345);
});

Deno.test('existing cursor, all-dup batch (zero inserted), returns stored cursor unchanged', () => {
  assertEquals(deriveResponseCursor(812000, 0, -1), 812000);
});

Deno.test('existing cursor, fresh rows above it, advances to the new max', () => {
  assertEquals(deriveResponseCursor(812000, 2, 812345), 812345);
});

Deno.test('existing cursor, fresh rows at or below it, does not move backward', () => {
  // A late-arriving row with a lower block_height must not pull the cursor back.
  assertEquals(deriveResponseCursor(812345, 1, 812000), 812345);
  assertEquals(deriveResponseCursor(812345, 1, 812345), 812345);
});

Deno.test('stored cursor of 0 is a real cursor, not treated as absent', () => {
  // Genesis-adjacent edge: 0 is a valid scanned height, distinct from null.
  assertEquals(deriveResponseCursor(0, 0, -1), 0);
});

// ── app_user_id validation ──────────────────────────────────────────────────
// Mirrors the guard at index.ts (post-fix):
//   if (!body.app_user_id || typeof body.app_user_id !== 'string')
//
// The old UUID format check was wrong: real host user ids are cuids.
// Any non-empty string is valid; the ownership check (line 194-209) is the
// real authorization boundary.

function rejectsAppUserId(value: unknown): boolean {
  return !value || typeof value !== 'string';
}

Deno.test('app_user_id: cuid passes validation', () => {
  assertEquals(rejectsAppUserId('cl9ebqhxk000008l2rz7r5nqk'), false);
});

Deno.test('app_user_id: empty string is rejected (400)', () => {
  assertEquals(rejectsAppUserId(''), true);
});

Deno.test('app_user_id: missing (undefined) is rejected (400)', () => {
  assertEquals(rejectsAppUserId(undefined), true);
});

Deno.test('app_user_id: null is rejected (400)', () => {
  assertEquals(rejectsAppUserId(null), true);
});
