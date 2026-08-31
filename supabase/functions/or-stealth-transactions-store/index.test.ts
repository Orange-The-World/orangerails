/**
 * Tests for or-stealth-transactions-store.
 *
 * Run with:
 *   deno test supabase/functions/or-stealth-transactions-store/index.test.ts
 *
 * Covers:
 *   - deriveResponseCursor semantics (DL-0419 trackMax-inside-guard).
 *   - boundedCursorAdvance: the cursor cannot pass the height the caller
 *     actually scanned contiguously (OR-T1120).
 *   - DL-0608 regression: app_user_id must accept cuids, not just UUIDs.
 *     Three stealth functions shared the UUID_RE validator on app_user_id
 *     and silently rejected every real customer's cuid since June. These
 *     tests fail if UUID-only validation is re-introduced in THIS function.
 *     The other two are not covered here, see the note below.
 */

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  boundedCursorAdvance,
  deriveResponseCursor,
  isSealedTx,
  isValidAppUserId,
} from './index.ts';

// ── DL-0608: cuid app_user_id must pass validation ────────────────────
//
// Real host-app user IDs are cuids (cuid2: ~26 chars, cuid v1: 25 chars),
// not UUIDs. The broken validator used UUID_RE which rejects any non-UUID
// string. The correct check is: typeof x === 'string' && x.length > 0.
//
// These tests guard or-stealth-transactions-store ONLY, because that is the
// only one of the three that exports isValidAppUserId. or-stealth-connection-list
// and or-stealth-connection-delete carry their own inline checks and never call
// this helper, so importing it here would prove nothing about them. Real guards
// for those two need the validator moved to _shared/ and imported by all three;
// that is tracked separately.
//
// If UUID_RE is re-added to this validator, the function starts rejecting cuids
// again and the assertion proving "cuid does NOT match UUID_RE" tells you why.

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

// -- isSealedTx guard --
//
// These tests call the REAL isSealedTx imported from index.ts.
// A mutation that loosens the field-name check (e.g. accepting 'iv'
// in place of 'iv_b64') must cause at least one of these to go red.

Deno.test('isSealedTx: accepts a valid sealed transaction object', () => {
  assert(isSealedTx({
    version: 1,
    algorithm: 'AES-256-GCM',
    iv_b64: 'AAAAAAAAAAAAAAAA',
    ciphertext_b64: 'AAAAAAAAAAAAAAAA',
    occurred_at: '2024-01-01',
    block_height: 1,
    txid_blind_index_hex: 'a'.repeat(64),
  }), 'valid object must pass isSealedTx');
});

Deno.test('isSealedTx: rejects object with iv instead of iv_b64 (catches _b64 field-name regression)', () => {
  assert(!isSealedTx({
    version: 1,
    algorithm: 'AES-256-GCM',
    iv: 'AAAAAAAAAAAAAAAA',
    ciphertext_b64: 'AAAAAAAAAAAAAAAA',
    occurred_at: '2024-01-01',
    block_height: 1,
    txid_blind_index_hex: 'a'.repeat(64),
  }), 'object with iv (not iv_b64) must fail isSealedTx');
});

Deno.test('isSealedTx: rejects object with ciphertext instead of ciphertext_b64', () => {
  assert(!isSealedTx({
    version: 1,
    algorithm: 'AES-256-GCM',
    iv_b64: 'AAAAAAAAAAAAAAAA',
    ciphertext: 'AAAAAAAAAAAAAAAA',
    occurred_at: '2024-01-01',
    block_height: 1,
    txid_blind_index_hex: 'a'.repeat(64),
  }), 'object with ciphertext (not ciphertext_b64) must fail isSealedTx');
});

Deno.test('isSealedTx: rejects null, non-objects, and malformed records', () => {
  assert(!isSealedTx(null), 'null must fail');
  assert(!isSealedTx('string'), 'string must fail');
  assert(!isSealedTx({ version: 2, algorithm: 'AES-256-GCM' }), 'wrong version must fail');
  assert(!isSealedTx({
    version: 1,
    algorithm: 'AES-256-GCM',
    iv_b64: 'AAAAAAAAAAAAAAAA',
    ciphertext_b64: 'AAAAAAAAAAAAAAAA',
    occurred_at: '2024-01-01',
    block_height: 1,
    txid_blind_index_hex: 'abc',
  }), 'short blind index hex must fail');
});

// -- app_user_id guard: call the real isValidAppUserId --
//
// All assertions below call the real isValidAppUserId exported from
// index.ts. An inline reimplementation would pass even if the shipped
// code were reverted, so the import is what makes this a genuine guard.

Deno.test('DL-0608: cuids pass isValidAppUserId (real function, not reimplemented)', () => {
  for (const cuid of CUID_EXAMPLES) {
    assert(isValidAppUserId(cuid), `cuid "${cuid}" must pass isValidAppUserId`);
  }
});

Deno.test('DL-0608: isValidAppUserId rejects empty string and non-strings', () => {
  assert(!isValidAppUserId(''), 'empty string must fail');
  assert(!isValidAppUserId(null), 'null must fail');
  assert(!isValidAppUserId(undefined), 'undefined must fail');
  assert(!isValidAppUserId(42), 'number must fail');
});

Deno.test('DL-0608: or-stealth-transactions-store -- cuids pass isValidAppUserId', () => {
  // or-stealth-transactions-store/index.ts: validator extracted to isValidAppUserId.
  // Reimplementing the check inline instead would not catch a revert.
  for (const cuid of CUID_EXAMPLES) {
    assert(isValidAppUserId(cuid), `cuid "${cuid}" must pass isValidAppUserId (or-stealth-transactions-store)`);
    assert(
      !UUID_RE_BROKEN_VALIDATOR.test(cuid),
      `cuid "${cuid}" would have been rejected by UUID_RE -- confirms the removed check was the bug`,
    );
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

// ── boundedCursorAdvance (OR-T1120) ──────────────────────────────────
//
// What this bounds is not a rounding question. A transaction can be inserted
// from ABOVE a coverage gap: the widget hits a permanent filter failure part
// way through a range, and its rolling-window extension pass then walks the
// whole range again and can match a block past the failure point. Advancing
// the cursor to that block's height marks the gap as scanned, every later sync
// starts above it, and a payment inside it is missing from the balance with no
// error and no retry.

Deno.test('boundedCursorAdvance: will not carry the cursor over a coverage gap', () => {
  assertEquals(
    boundedCursorAdvance(900_120, 900_100),
    900_100,
    'a tx inserted 20 blocks above the gap cannot advance the cursor past the gap',
  );
  assertEquals(
    deriveResponseCursor(900_000, 1, boundedCursorAdvance(900_120, 900_100)),
    900_100,
    'the cursor reported to the caller is the bounded one, so it matches what was persisted',
  );
});

Deno.test('boundedCursorAdvance: does not hold the cursor back in the normal case', () => {
  assertEquals(
    boundedCursorAdvance(900_100, 900_120),
    900_100,
    'scanned past the last transaction found: the transaction height still wins',
  );
  assertEquals(
    boundedCursorAdvance(900_100, 900_100),
    900_100,
    'transaction in the last scanned block: unchanged',
  );
});

Deno.test('boundedCursorAdvance: the ceiling can only narrow, never widen', () => {
  // This is the property that makes taking a client-supplied value safe here
  // when the function deliberately refuses to trust the same field as a cursor.
  // A caller claiming an enormous scanned height gains nothing, because the
  // height being bounded is itself derived from rows that caller sent.
  assertEquals(
    boundedCursorAdvance(900_100, 9_999_999),
    900_100,
    'an inflated scanned height cannot push the cursor past the rows that landed',
  );
  assertEquals(
    deriveResponseCursor(900_000, 0, boundedCursorAdvance(-1, 9_999_999)),
    900_000,
    'nothing inserted: the ceiling cannot invent an advance out of no rows',
  );
});

Deno.test('boundedCursorAdvance: no usable ceiling leaves the advance exactly as before', () => {
  // Not reachable over HTTP: the request path already answers 400 when
  // last_block_scanned is absent or is not a non-negative integer. Pinned
  // anyway because the function is exported, and because the direction of the
  // fallback matters: no ceiling must mean "behave as before", never "advance
  // to zero".
  assertEquals(
    boundedCursorAdvance(900_100, undefined),
    900_100,
    'absent ceiling: unchanged',
  );
  assertEquals(
    boundedCursorAdvance(900_100, null),
    900_100,
    'null ceiling: unchanged',
  );
  assertEquals(
    boundedCursorAdvance(900_100, '900000'),
    900_100,
    'a numeric string is not a ceiling',
  );
  assertEquals(
    boundedCursorAdvance(900_100, 900_000.5),
    900_100,
    'a non-integer is not a ceiling',
  );
});
