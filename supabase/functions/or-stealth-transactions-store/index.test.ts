/**
 * Tests for or-stealth-transactions-store.
 *
 * Run with:
 *   deno test supabase/functions/or-stealth-transactions-store/index.test.ts
 *
 * Covers:
 *   - deriveResponseCursor semantics (DL-0419 trackMax-inside-guard).
 *   - DL-0608 regression: app_user_id must accept cuids, not just UUIDs.
 *     Three stealth functions shared the UUID_RE validator on app_user_id
 *     and silently rejected every real customer's cuid since June. These
 *     tests fail if UUID-only validation is re-introduced in THIS function.
 *     The other two are not covered here, see the note below.
 */

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { deriveResponseCursor, isSealedTx, isValidAppUserId } from './index.ts';

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

// ── deriveResponseCursor (DL-0419 trackMax-inside-guard, DL-1188 zero-match) ──
//
// Semantics (updated for DL-1188):
//   inserted > 0: advance to maxBlockInserted only (not scanTip). Preserves the
//                 DL-0419 guard: never jump past uncommitted items in the range.
//   inserted === 0: advance to scanTip (body.last_block_scanned) so the same
//                   empty range is not rescanned forever (DL-1188 fix). Safe:
//                   no uncommitted items exist in the range.
//   Forward-only in both paths: candidate must strictly exceed storedCursor.

Deno.test('deriveResponseCursor: advances to maxBlockInserted when rows inserted', () => {
  assertEquals(
    deriveResponseCursor(null, 3, 500, 600),
    500,
    'null stored cursor with inserts advances to maxBlockInserted, not scanTip',
  );
  assertEquals(
    deriveResponseCursor(100, 2, 150, 200),
    150,
    'advances to maxBlockInserted (not scanTip) when rows landed',
  );
  assertEquals(
    deriveResponseCursor(0, 1, 1, 5),
    1,
    'advances from block 0 to maxBlockInserted=1, not scanTip=5',
  );
});

Deno.test('deriveResponseCursor: zero-match scan advances cursor to scan tip (DL-1188)', () => {
  // When zero rows are inserted (empty scan or all-duplicate batch), the cursor
  // must advance to the scan tip so the same range is not rescanned forever.
  assertEquals(
    deriveResponseCursor(null, 0, -1, 100),
    100,
    'fresh connection zero-match scan: advances to scan tip 100',
  );
  assertEquals(
    deriveResponseCursor(100, 0, -1, 200),
    200,
    'zero inserts with scan tip 200 advances past stored cursor 100',
  );
  assertEquals(
    deriveResponseCursor(0, 0, -1, 50),
    50,
    'zero inserts at cursor=0 advances to scan tip 50',
  );
});

Deno.test('deriveResponseCursor: forward-only guard applies to both inserted and zero-match paths', () => {
  // inserted > 0 path: maxBlockInserted must exceed storedCursor.
  assertEquals(
    deriveResponseCursor(500, 3, 400, 600),
    500,
    'lower maxBlockInserted preserves cursor even with inserts',
  );
  assertEquals(
    deriveResponseCursor(500, 3, 500, 600),
    500,
    'equal maxBlockInserted does not advance (strictly greater required)',
  );
  // inserted === 0 path: scanTip must exceed storedCursor.
  assertEquals(
    deriveResponseCursor(500, 0, -1, 400),
    500,
    'zero inserts: scan tip below stored cursor -- cursor stays',
  );
  assertEquals(
    deriveResponseCursor(500, 0, -1, 500),
    500,
    'zero inserts: scan tip equal to stored cursor -- cursor stays',
  );
});

Deno.test('deriveResponseCursor: inserted path uses maxBlockInserted not scanTip (DL-0419 guard)', () => {
  // When rows are inserted, the cursor advances to maxBlockInserted only.
  // Using scanTip when rows were inserted would be the DL-0015 bug: jumping
  // past items in the scan range that were not committed by this batch.
  assertEquals(
    deriveResponseCursor(100, 5, 150, 9999),
    150,
    'inserted rows: advances to maxBlockInserted=150, not scanTip=9999',
  );
});
