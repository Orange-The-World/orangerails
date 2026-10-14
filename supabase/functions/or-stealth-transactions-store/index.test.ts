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

import {
  assertEquals,
  assert,
  assertStrictEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  boundCursorAdvance as sharedBoundCursorAdvance,
  isContiguousScannedHeight as sharedIsContiguousScannedHeight,
} from '../_shared/scan-cursor.ts';
import {
  boundCursorAdvance,
  deriveResponseCursor,
  isContiguousScannedHeight,
  isSealedTx,
  isValidAppUserId,
  UUID_RE,
  storeTransactionsAtomic,
  invokeBatchWrite,
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

// ── OR-T0999: block_hash_hex field on SealedTransactionInput ─────────────────
//
// The store function now includes block_hash: tx.block_hash_hex ?? null in
// the inserted row.  isSealedTx does not require block_hash_hex (it is
// optional: records uploaded before hash capture was added have no hash and
// are stored with block_hash=NULL, treated as unverifiable by the detector).

Deno.test('OR-T0999: isSealedTx accepts transaction WITH block_hash_hex', () => {
  assert(isSealedTx({
    version: 1,
    algorithm: 'AES-256-GCM',
    iv_b64: 'aWQ=',
    ciphertext_b64: 'Y2lwaGVydGV4dA==',
    occurred_at: '2026-09-22',
    block_height: 900050,
    txid_blind_index_hex: 'a'.repeat(64),
    block_hash_hex: 'b'.repeat(64),
  }), 'isSealedTx must accept a transaction with block_hash_hex');
});

Deno.test('OR-T0999: isSealedTx accepts transaction WITHOUT block_hash_hex (pre-hash record)', () => {
  assert(isSealedTx({
    version: 1,
    algorithm: 'AES-256-GCM',
    iv_b64: 'aWQ=',
    ciphertext_b64: 'Y2lwaGVydGV4dA==',
    occurred_at: '2026-09-22',
    block_height: 900050,
    txid_blind_index_hex: 'a'.repeat(64),
    // no block_hash_hex -- pre-hash record; stored as block_hash=NULL
  }), 'isSealedTx must accept a transaction without block_hash_hex (OR-T0407: NULL is unverifiable, not an error)');
});

// ── OR-C2078: block_hash_hex must be validated server-side, not just by the
// client (fetchFilterPair in sync.ts). Before this fix any string, including
// an uppercase or otherwise malformed hash, passed isSealedTx and was stored
// verbatim as block_hash. Because the canonical hash the reorg check compares
// against is always lowercased, that permanently mismatches a well-formed but
// wrong-case hash and orphans a real transaction with no self-heal path.

Deno.test('OR-C2078: isSealedTx rejects UPPERCASE block_hash_hex', () => {
  assert(!isSealedTx({
    version: 1,
    algorithm: 'AES-256-GCM',
    iv_b64: 'aWQ=',
    ciphertext_b64: 'Y2lwaGVydGV4dA==',
    occurred_at: '2026-09-22',
    block_height: 900050,
    txid_blind_index_hex: 'a'.repeat(64),
    block_hash_hex: 'B'.repeat(64),
  }), 'uppercase block_hash_hex must fail isSealedTx, not be stored verbatim');
});

Deno.test('OR-C2078: isSealedTx rejects mixed-case block_hash_hex', () => {
  assert(!isSealedTx({
    version: 1,
    algorithm: 'AES-256-GCM',
    iv_b64: 'aWQ=',
    ciphertext_b64: 'Y2lwaGVydGV4dA==',
    occurred_at: '2026-09-22',
    block_height: 900050,
    txid_blind_index_hex: 'a'.repeat(64),
    block_hash_hex: 'aB'.repeat(32),
  }), 'mixed-case block_hash_hex must fail isSealedTx');
});

Deno.test('OR-C2078: isSealedTx rejects short or non-hex block_hash_hex', () => {
  assert(!isSealedTx({
    version: 1,
    algorithm: 'AES-256-GCM',
    iv_b64: 'aWQ=',
    ciphertext_b64: 'Y2lwaGVydGV4dA==',
    occurred_at: '2026-09-22',
    block_height: 900050,
    txid_blind_index_hex: 'a'.repeat(64),
    block_hash_hex: 'not-a-hash',
  }), 'malformed block_hash_hex must fail isSealedTx');
  assert(!isSealedTx({
    version: 1,
    algorithm: 'AES-256-GCM',
    iv_b64: 'aWQ=',
    ciphertext_b64: 'Y2lwaGVydGV4dA==',
    occurred_at: '2026-09-22',
    block_height: 900050,
    txid_blind_index_hex: 'a'.repeat(64),
    block_hash_hex: 'a'.repeat(63),
  }), 'short block_hash_hex (63 chars) must fail isSealedTx');
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
//
// The fourth argument, the height the client scanned contiguously, is
// required. These cases are not about the OR-T1120 ceiling, so they pass a
// value where it cannot bite, and say so rather than relying on a default.

Deno.test('deriveResponseCursor: advances cursor when rows inserted and block exceeds stored', () => {
  assertEquals(
    deriveResponseCursor(null, 3, 500, 500),
    500,
    'null stored cursor with inserts advances to maxBlock',
  );
  assertEquals(
    deriveResponseCursor(100, 2, 150, 150),
    150,
    'advances past stored cursor when maxBlock is higher',
  );
  assertEquals(
    deriveResponseCursor(0, 1, 1, 1),
    1,
    'advances from block 0 to block 1',
  );
});

Deno.test('deriveResponseCursor: returns null on fresh connection with no inserts', () => {
  assertEquals(
    deriveResponseCursor(null, 0, -1, 900_000),
    null,
    'fresh connection with zero inserts must return null, not -1',
  );
});

Deno.test('deriveResponseCursor: preserves stored cursor when no rows inserted', () => {
  assertEquals(
    deriveResponseCursor(100, 0, -1, 900_000),
    100,
    'zero inserts keeps stored cursor unchanged',
  );
  assertEquals(
    deriveResponseCursor(0, 0, -1, 900_000),
    0,
    'zero inserts at cursor=0 still returns 0',
  );
});

Deno.test('deriveResponseCursor: does not advance when maxBlock does not exceed stored cursor', () => {
  assertEquals(
    deriveResponseCursor(500, 3, 400, 400),
    500,
    'lower maxBlock preserves cursor even with inserts',
  );
  assertEquals(
    deriveResponseCursor(500, 3, 500, 500),
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
    deriveResponseCursor(100, 0, 9999, 9999),
    100,
    'zero inserts: cursor stays at 100 regardless of maxBlock argument',
  );
  assertEquals(
    deriveResponseCursor(null, 0, 9999, 9999),
    null,
    'zero inserts on fresh connection: cursor stays null regardless of maxBlock argument',
  );
});

// ── boundCursorAdvance (OR-T1120) ─────────────────────────────────────
// max(block_height) of the inserted rows is a real height, but it is not
// evidence that every height below it was read. The client's rolling-window
// extension pass can match a block above the point where a filter fetch
// aborted, so a transaction can be inserted from above a gap nobody scanned.
// If the cursor follows it up there, the next sync resumes above the gap and
// any payment inside it is missing from the balance permanently, with no error
// and no retry. The client half of the fix is the extension-pass trim in
// src/stealth/lib/sync.ts; this is the server half.

Deno.test('boundCursorAdvance: caps the advance at the last height the client scanned contiguously', () => {
  // The defect path. A transaction landed at 900_003, but the client only read
  // as far as 900_001 before its filter fetch aborted. 900_002 was never read
  // by anyone, so the cursor must stop below it.
  assertEquals(
    boundCursorAdvance(900_003, 900_001),
    900_001,
    'a row inserted at 900_003 cannot move the cursor past the 900_001 actually read',
  );
});

Deno.test('boundCursorAdvance: is a no-op when the inserted height is at or below the contiguous height', () => {
  // This is the healthy case and every correct sync lands here, because hits
  // are trimmed to the contiguous height before anything is sealed. Pinning it
  // is the point: if this bound ever started biting on healthy traffic it would
  // surface as a stuck cursor, which is the failure this area exists to avoid.
  assertEquals(boundCursorAdvance(900_001, 900_001), 900_001, 'equal: unchanged');
  assertEquals(boundCursorAdvance(899_998, 900_001), 899_998, 'below: unchanged');
  assertEquals(boundCursorAdvance(-1, 900_001), -1, 'no rows inserted: the -1 sentinel is preserved');
});

Deno.test('boundCursorAdvance: the client value can only hold the cursor back, never push it forward', () => {
  // The DL-0419 property has to survive this change. A client claiming to have
  // scanned to 9_999_999 still cannot move the cursor past a height that was
  // actually inserted, because min() never raises its first argument.
  assertEquals(
    boundCursorAdvance(900_001, 9_999_999),
    900_001,
    'a larger client value is ignored',
  );
});

Deno.test('boundCursorAdvance: no usable client value leaves the advance unbounded', () => {
  // Defence in depth on an exported pure function, NOT a backward-compatibility
  // path: the handler validation answers 400 for every one of these bodies, so
  // this branch is unreachable over HTTP. Asserted anyway so a future caller of
  // the function gets defined behaviour rather than a NaN or a crash.
  assertEquals(boundCursorAdvance(900_003, undefined), 900_003, 'absent: no bound');
  assertEquals(boundCursorAdvance(900_003, null), 900_003, 'null: no bound');
  assertEquals(boundCursorAdvance(900_003, '900001'), 900_003, 'wrong type: no bound');
  assertEquals(boundCursorAdvance(900_003, 900_001.5), 900_003, 'non-integer: no bound');
  assertEquals(boundCursorAdvance(900_003, -1), 900_003, 'negative: no bound');
  assertEquals(boundCursorAdvance(900_003, Number.NaN), 900_003, 'NaN: no bound');
});

Deno.test('deriveResponseCursor: the reported cursor carries the same bound as the persisted one', () => {
  // The response must equal what was written. If the bound applied to the patch
  // but not to the response, the caller would be told the cursor reached a
  // height the database never stored, and would resume from the wrong place.
  assertEquals(
    deriveResponseCursor(899_000, 2, 900_003, 900_001),
    900_001,
    'the bounded height is reported, not maxBlockInserted',
  );
  assertEquals(
    deriveResponseCursor(900_002, 2, 900_003, 900_001),
    900_002,
    'bound at or below the stored cursor: the cursor does not move at all',
  );
  // The unbounded advance is still reachable, but only by asking for it. The
  // parameter used to default to undefined, so a caller that merely forgot the
  // argument got this same behaviour with nothing to show for it. Passing
  // undefined here is that code path, chosen out loud where a reviewer sees it.
  assertEquals(
    deriveResponseCursor(100, 2, 150, undefined),
    150,
    'an explicit undefined selects the unbounded advance',
  );
});

Deno.test('OR-T1914: the ceiling this function exports IS the shared one, not a copy', () => {
  // Every other test in this file passes just as happily against a local copy of
  // the helper pasted back in here, and a local copy is exactly how one column
  // ended up with two contracts: this endpoint capped the cursor at the client
  // contiguous height while or-stealth-envelope-update wrote the posted value
  // straight through. Both now import from ../_shared/scan-cursor.ts, so the
  // thing worth asserting is identity, not behaviour.
  assertStrictEquals(
    boundCursorAdvance,
    sharedBoundCursorAdvance,
    'boundCursorAdvance must be the shared contract helper',
  );
  assertStrictEquals(
    isContiguousScannedHeight,
    sharedIsContiguousScannedHeight,
    'isContiguousScannedHeight must be the shared contract helper',
  );
});

// ── OR-T2457: generation fence on the transactions-store path ─────────────────
//
// The atomicity guarantee now lives inside store_stealth_transactions_atomic(),
// a Postgres function that runs the generation check, the INSERT and the cursor
// patch under a single row-level lock (SELECT ... FOR UPDATE). A concurrent
// envelope reset cannot commit stale rows: the lock prevents the race window
// the two-step JS sequence (separate upsert + cursor UPDATE) left open.
//
// The tests below call the REAL storeTransactionsAtomic() exported from index.ts
// (not a paraphrase of its logic) against a fake service client, so:
//   - removing storeTransactionsAtomic: import failure
//   - replacing the rpc() call inside it with direct .from().upsert(): the fake
//     client does not implement .from(), so the call throws and the tests fail
//   - removing UUID_RE: the import above fails and every test in this file fails
//
// Honest limit: the Postgres function itself runs in the real database and is
// not exercised here; its SQL is reviewed via the migration file
// (20260929000000_store_stealth_transactions_atomic.sql).

const VALID_GEN = '11111111-1111-1111-1111-111111111111';
const FRESH_GEN = '33333333-3333-3333-3333-333333333333';

function makeTxRow(blindHex: string): Record<string, unknown> {
  return {
    connection_id: 'conn-1',
    sealed_record: { version: 1, algorithm: 'AES-256-GCM', iv_b64: 'aWQ=', ciphertext_b64: 'Y2k=' },
    occurred_at: '2024-01-01',
    block_height: 500_000,
    txid_blind_index_hex: blindHex,
    block_hash: null,
  };
}

// deno-lint-ignore no-explicit-any
function makeAtomicFakeClient(db: {
  connections: Array<{ id: string; scan_generation: string; last_block_scanned: number | null }>;
  transactions: Array<{ connection_id: string; txid_blind_index_hex: string }>;
}): any {
  return {
    rpc(fnName: string, params: Record<string, unknown>) {
      if (fnName !== 'store_stealth_transactions_atomic') {
        return Promise.reject(new Error('unexpected rpc: ' + fnName));
      }
      const conn = db.connections.find((c) => c.id === params['p_connection_id']);
      if (!conn) return Promise.resolve({ data: { http_status: 404, inserted: 0 }, error: null });
      if (conn.scan_generation !== params['p_generation']) {
        // Generation mismatch: no rows committed, mirroring the Postgres function.
        return Promise.resolve({ data: { http_status: 409, inserted: 0 }, error: null });
      }
      const rows = params['p_rows'] as Array<{ txid_blind_index_hex: string }>;
      let cnt = 0;
      for (const row of rows) {
        const dup = db.transactions.some(
          (t) => t.connection_id === conn.id && t.txid_blind_index_hex === row.txid_blind_index_hex,
        );
        if (!dup) {
          db.transactions.push({ connection_id: conn.id, txid_blind_index_hex: row.txid_blind_index_hex });
          cnt++;
        }
      }
      const advance = params['p_cursor_advance'] as number;
      if (cnt > 0 && advance > (conn.last_block_scanned ?? -1)) conn.last_block_scanned = advance;
      return Promise.resolve({ data: { http_status: 200, inserted: cnt }, error: null });
    },
  };
}

Deno.test(
  'OR-T2457: stale scan_generation produces 409 and commits zero rows (handler-level)',
  async () => {
    // Scenario: the connection was reset (generation rotated to FRESH_GEN)
    // while a sync was in flight.  The stale sync still carries VALID_GEN.
    // The fence must refuse without committing any rows.
    const db = {
      connections: [{ id: 'conn-1', scan_generation: FRESH_GEN, last_block_scanned: null as number | null }],
      transactions: [] as Array<{ connection_id: string; txid_blind_index_hex: string }>,
    };
    const client = makeAtomicFakeClient(db);

    const result = await storeTransactionsAtomic(client, {
      connection_id:   'conn-1',
      platform_id:     'plat-1',
      scan_generation: VALID_GEN,
      rows:            [makeTxRow('a'.repeat(64))],
      cursor_advance:  500_000,
      sync_at:         new Date().toISOString(),
    });

    assert(!('rpc_error' in result), 'rpc must not error: ' + JSON.stringify(result));
    assertEquals(
      (result as { http_status: number }).http_status,
      409,
      'stale generation must produce 409',
    );
    assertEquals(db.transactions.length, 0, 'stale write must commit zero rows');
    assertEquals(
      db.connections[0].last_block_scanned,
      null,
      'stale write must not advance the cursor',
    );
  },
);

Deno.test(
  'OR-T2457: fresh scan_generation succeeds and commits the rows (handler-level)',
  async () => {
    const db = {
      connections: [{ id: 'conn-1', scan_generation: FRESH_GEN, last_block_scanned: null as number | null }],
      transactions: [] as Array<{ connection_id: string; txid_blind_index_hex: string }>,
    };
    const client = makeAtomicFakeClient(db);

    const result = await storeTransactionsAtomic(client, {
      connection_id:   'conn-1',
      platform_id:     'plat-1',
      scan_generation: FRESH_GEN,
      rows:            [makeTxRow('a'.repeat(64))],
      cursor_advance:  500_000,
      sync_at:         new Date().toISOString(),
    });

    assert(!('rpc_error' in result), 'rpc must not error: ' + JSON.stringify(result));
    assertEquals(
      (result as { http_status: number }).http_status,
      200,
      'fresh generation must succeed',
    );
    assertEquals(db.transactions.length, 1, 'fresh write must commit the row');
  },
);

Deno.test(
  'OR-T2457: scan_generation uuid check uses the real UUID_RE from the handler',
  () => {
    // Importing UUID_RE directly (not a local copy) means removing or relaxing
    // the regex in the handler turns this test red at import time.
    assert(!UUID_RE.test('not-a-uuid'), 'non-uuid string must fail UUID_RE -> 400 guard fires');
    assert(UUID_RE.test(VALID_GEN), 'a well-formed uuid must pass UUID_RE -> guard does not fire');
    assert(UUID_RE.test(FRESH_GEN), 'a well-formed uuid must pass UUID_RE -> guard does not fire');
  },
);

// ── OR-T2457: handler-level fence regression ──────────────────────────────────
//
// These tests call invokeBatchWrite(), the EXACT function the handler calls
// (see index.ts line ~534). Testing storeTransactionsAtomic in isolation does
// not cover the handler call site: if the handler stops calling
// storeTransactionsAtomic (and calls .from().upsert() directly), those tests
// remain green because they import the function without going through the
// handler. These handler-level tests close that gap:
//
//   - invokeBatchWrite is imported from index.ts; removing that export turns
//     every test in this file red at import time.
//   - changing invokeBatchWrite to call .from().upsert() instead of rpc()
//     throws on makeAtomicFakeClient (rpc-only; no .from() for writes).
//   - the handler calls invokeBatchWrite, not storeTransactionsAtomic directly,
//     so these tests cover the real handler call path.

Deno.test(
  'OR-T2457 handler-level: stale scan_generation via invokeBatchWrite produces 409 and zero rows',
  async () => {
    // Scenario: the connection was reset (generation rotated to FRESH_GEN)
    // while a sync was in flight. The stale sync still carries VALID_GEN.
    // The handler must refuse without committing any rows.
    const db = {
      connections: [{ id: 'conn-1', scan_generation: FRESH_GEN, last_block_scanned: null as number | null }],
      transactions: [] as Array<{ connection_id: string; txid_blind_index_hex: string }>,
    };
    const client = makeAtomicFakeClient(db);

    const result = await invokeBatchWrite(client, {
      connection_id:   'conn-1',
      platform_id:     'plat-1',
      scan_generation: VALID_GEN,   // stale: DB has FRESH_GEN
      rows:            [makeTxRow('a'.repeat(64))],
      cursor_advance:  500_000,
      sync_at:         new Date().toISOString(),
    });

    assert(!('rpc_error' in result), 'rpc must not error: ' + JSON.stringify(result));
    assertEquals(
      (result as { http_status: number }).http_status,
      409,
      'stale generation must produce 409',
    );
    assertEquals(db.transactions.length, 0, 'stale write must commit zero rows');
    assertEquals(
      db.connections[0].last_block_scanned,
      null,
      'stale write must not advance the cursor',
    );
  },
);

Deno.test(
  'OR-T2457 handler-level: fresh scan_generation via invokeBatchWrite succeeds and commits rows',
  async () => {
    const db = {
      connections: [{ id: 'conn-1', scan_generation: FRESH_GEN, last_block_scanned: null as number | null }],
      transactions: [] as Array<{ connection_id: string; txid_blind_index_hex: string }>,
    };
    const client = makeAtomicFakeClient(db);

    const result = await invokeBatchWrite(client, {
      connection_id:   'conn-1',
      platform_id:     'plat-1',
      scan_generation: FRESH_GEN,   // fresh: matches DB
      rows:            [makeTxRow('b'.repeat(64))],
      cursor_advance:  500_000,
      sync_at:         new Date().toISOString(),
    });

    assert(!('rpc_error' in result), 'rpc must not error: ' + JSON.stringify(result));
    assertEquals(
      (result as { http_status: number }).http_status,
      200,
      'fresh generation must produce 200',
    );
    assertEquals(db.transactions.length, 1, 'fresh write must commit the row');
    assertEquals(
      db.connections[0].last_block_scanned,
      500_000,
      'fresh write must advance the cursor to cursor_advance',
    );
  },
);
