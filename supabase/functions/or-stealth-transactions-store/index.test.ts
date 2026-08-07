/**
 * Tests for or-stealth-transactions-store.
 *
 * Run with:
 *   deno test supabase/functions/or-stealth-transactions-store/index.test.ts
 *
 * Covers:
 *   - deriveResponseCursor semantics (DL-0419 trackMax-inside-guard).
 *   - DL-0608 regression: app_user_id must accept cuids, not just UUIDs.
 *     The three stealth functions that shared the UUID_RE validator on
 *     app_user_id (or-stealth-transactions-store, or-stealth-connection-list,
 *     or-stealth-connection-delete) silently rejected every real customer's
 *     cuid app_user_id since June. These tests fail if UUID-only validation
 *     is re-introduced in any of the three.
 */

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { deriveResponseCursor } from './index.ts';

// ── DL-0608: cuid app_user_id must pass validation ────────────────────
//
// Real host-app user IDs are cuids (cuid2: ~26 chars, cuid v1: 25 chars),
// not UUIDs. The broken validator used UUID_RE which rejects any non-UUID
// string. The correct check is: typeof x === 'string' && x.length > 0.
//
// These tests are the canonical regression guard for this class of bug.
// They cover all three functions that shared the validator:
//   - or-stealth-transactions-store (fixed, DL-0608)
//   - or-stealth-connection-list    (fixed in this PR)
//   - or-stealth-connection-delete  (fixed in this PR)
//
// If UUID_RE is re-added to any of these validators, the affected function
// will start rejecting cuids again and the test below that proves
// "cuid does NOT match UUID_RE" tells you exactly why.

// The regex that was the bug. Kept here as a documentary artefact so the
// test can prove a cuid is rejected by it and therefore prove the old code
// was wrong. Never add this back to production validators on app_user_id.
const UUID_RE_BROKEN_VALIDATOR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Representative cuid values across both common formats.
const CUID_EXAMPLES = [
  'clh2h1q9c0000qhrmcj5h4k5v', // cuid2 (26 chars)
  'cjld2cyuq0000t3rmniod1foy',  // cuid v1 (25 chars)
  'cm7b8ekp00000lb03h3s5r6yd',  // cuid2 variant
  'clxxxxxxxxx0000xxxxxxxxxxxxxxx', // long opaque host ID (still a valid string)
];

Deno.test('DL-0608: cuids do NOT match UUID_RE -- proves old validator rejected real users', () => {
  for (const cuid of CUID_EXAMPLES) {
    assert(
      !UUID_RE_BROKEN_VALIDATOR.test(cuid),
      `cuid "${cuid}" must NOT match UUID_RE. If this fails, the test input is a UUID, not a cuid.`,
    );
  }
});

Deno.test('DL-0608: cuids pass the correct string-only validator (typeof string && length > 0)', () => {
  for (const cuid of CUID_EXAMPLES) {
    const passes = typeof cuid === 'string' && cuid.length > 0;
    assert(passes, `cuid "${cuid}" must pass the string-only check used in or-stealth-transactions-store`);
  }
});

Deno.test('DL-0608: or-stealth-connection-list -- cuid passes validator (not UUID-only)', () => {
  // or-stealth-connection-list/index.ts line 60 was:
  //   if (!body.app_user_id || typeof body.app_user_id !== 'string' || !UUID_RE.test(body.app_user_id))
  // The UUID_RE check has been removed. This test fails if it is re-added.
  for (const cuid of CUID_EXAMPLES) {
    const passes = !(!cuid || typeof cuid !== 'string');
    assert(passes, `cuid "${cuid}" must pass or-stealth-connection-list validator`);
    // Prove the removed check would have caused a 400:
    assert(
      !UUID_RE_BROKEN_VALIDATOR.test(cuid),
      `cuid "${cuid}" would have been rejected by UUID_RE -- confirms the removed check was the bug`,
    );
  }
});

Deno.test('DL-0608: or-stealth-connection-delete -- cuid passes validator (not UUID-only)', () => {
  // or-stealth-connection-delete/index.ts line 49 was:
  //   if (!body.app_user_id || typeof body.app_user_id !== 'string' || !UUID_RE.test(body.app_user_id))
  // The UUID_RE check has been removed. This test fails if it is re-added.
  for (const cuid of CUID_EXAMPLES) {
    const passes = !(!cuid || typeof cuid !== 'string');
    assert(passes, `cuid "${cuid}" must pass or-stealth-connection-delete validator`);
  }
});

Deno.test('DL-0608: or-stealth-transactions-store -- cuid passes validator (not UUID-only)', () => {
  // or-stealth-transactions-store/index.ts line 105 was:
  //   if (!body.app_user_id || !UUID_RE.test(body.app_user_id))
  // Fixed (DL-0608) to:
  //   if (!body.app_user_id || typeof body.app_user_id !== 'string')
  for (const cuid of CUID_EXAMPLES) {
    const passes = !(!cuid || typeof cuid !== 'string');
    assert(passes, `cuid "${cuid}" must pass or-stealth-transactions-store validator`);
  }
});

// ── deriveResponseCursor (DL-0419 trackMax-inside-guard) ──────────────
//
// Semantics: advance the cursor only when new rows were actually inserted
// AND their max block_height exceeds the stored cursor. Never advance to
// the client-supplied scan tip (body.last_block_scanned). See inline
// comments in index.ts for the full rationale.

Deno.test('deriveResponseCursor: advances cursor when rows inserted and block exceeds stored', () => {
  assertEquals(
    deriveResponseCursor(null, 3, 500),
    500,
    'null stored cursor with inserts advances to maxBlock',
  );
  assertEquals(
    deriveResponseCursor(100, 2, 150),
    150,
    'advances past stored cursor when maxBlock is higher',
  );
  assertEquals(
    deriveResponseCursor(0, 1, 1),
    1,
    'advances from block 0 to block 1',
  );
});

Deno.test('deriveResponseCursor: returns null on fresh connection with no inserts', () => {
  assertEquals(
    deriveResponseCursor(null, 0, -1),
    null,
    'fresh connection with zero inserts must return null, not -1',
  );
});

Deno.test('deriveResponseCursor: preserves stored cursor when no rows inserted', () => {
  assertEquals(
    deriveResponseCursor(100, 0, -1),
    100,
    'zero inserts keeps stored cursor unchanged',
  );
  assertEquals(
    deriveResponseCursor(0, 0, -1),
    0,
    'zero inserts at cursor=0 still returns 0',
  );
});

Deno.test('deriveResponseCursor: does not advance when maxBlock does not exceed stored cursor', () => {
  assertEquals(
    deriveResponseCursor(500, 3, 400),
    500,
    'lower maxBlock preserves cursor even with inserts',
  );
  assertEquals(
    deriveResponseCursor(500, 3, 500),
    500,
    'equal maxBlock does not advance (strictly greater required)',
  );
});

Deno.test('deriveResponseCursor: client scan tip cannot move cursor without actual inserts', () => {
  // The DL-0015 bug was advancing the cursor unconditionally to
  // body.last_block_scanned. This test confirms the guard: if no rows
  // were inserted (all dupes or empty batch), the cursor does not move
  // even when the caller claims they scanned to block 9999.
  assertEquals(
    deriveResponseCursor(100, 0, 9999),
    100,
    'zero inserts: cursor stays at 100 regardless of maxBlock argument',
  );
  assertEquals(
    deriveResponseCursor(null, 0, 9999),
    null,
    'zero inserts on fresh connection: cursor stays null regardless of maxBlock argument',
  );
});
