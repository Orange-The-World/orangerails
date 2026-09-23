/**
 * Unit tests for the scan-range RPC payload (DL-1597, DL-1610).
 *
 * Run with: deno test --no-check supabase/functions/or-stealth-envelope-update/
 *
 * The first test is the regression guard for the defect that made the first
 * version of the database owner check unreachable. Read the module comment in
 * scan_range.ts for the full reasoning; the short version is that the handler
 * passed the app_user_id it had just read from the connection row, so the
 * database compared the owner against itself and could never reject anything.
 *
 * That test fails against the pre-fix handler and passes against this branch,
 * which is the property the review asked for.
 */

// @ts-nocheck -- matches the --no-check CI flag; type coverage is the ratchet job.

import {
  assertEquals,
  assertNotEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  buildScanRangeArgs,
  classifyScanRangeError,
  classifySkipReason,
  recordScanRange,
  UNKNOWN_ERROR_CODE,
} from './scan_range.ts';

const CONN_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/** The identity of the signed-in caller making the request. */
const CALLER = 'user-making-the-request';

/**
 * The owner of CONN_ID as stored in stealth_connections, i.e. the value the
 * database resolves for itself and compares against. The pre-fix handler read
 * this value and passed it back in, which is what left the comparison unable
 * to distinguish anything.
 */
const CONNECTION_OWNER = 'user-owning-the-connection';

Deno.test(
  'payload carries the CALLER id, not the connection owner, so the database check can reject',
  () => {
    const args = buildScanRangeArgs({
      connection_id: CONN_ID,
      app_user_id: CALLER,
      last_block_scanned: 900_100,
      from_height: 900_000,
    });

    assertNotEquals(args, null);
    if (args === null) return;

    // The assertion that fails against the pre-fix handler. It passed
    // CONNECTION_OWNER here, and the database compares the value it is given
    // against that same owner: always equal, so no input could be rejected.
    assertNotEquals(
      args.p_app_user_id,
      CONNECTION_OWNER,
      'payload must not carry the connection owner: the database compares against that same value, so the ownership check would be unable to fail',
    );
    assertEquals(args.p_app_user_id, CALLER);
  },
);

Deno.test('payload shape matches the 4-arg record_stealth_scan_range signature', () => {
  const args = buildScanRangeArgs({
    connection_id: CONN_ID,
    app_user_id: CALLER,
    last_block_scanned: 900_100,
    from_height: 900_000,
  });

  assertEquals(args, {
    p_connection_id: CONN_ID,
    p_from_height: 900_000,
    p_to_height: 900_100,
    p_app_user_id: CALLER,
  });
});

Deno.test('recordScanRange sends the caller id through to the RPC', async () => {
  let capturedFn: string | null = null;
  // deno-lint-ignore no-explicit-any
  let capturedArgs: any = null;
  const client = {
    // deno-lint-ignore no-explicit-any
    rpc(fn: string, args: any) {
      capturedFn = fn;
      capturedArgs = args;
      return Promise.resolve({ error: null });
    },
  };

  await recordScanRange(client, {
    connection_id: CONN_ID,
    app_user_id: CALLER,
    last_block_scanned: 900_100,
    from_height: 900_000,
  });

  assertEquals(capturedFn, 'record_stealth_scan_range');
  assertEquals(capturedArgs.p_app_user_id, CALLER);
  assertNotEquals(capturedArgs.p_app_user_id, CONNECTION_OWNER);
});

Deno.test('no from_height: opt-out, no RPC is issued at all', async () => {
  let called = false;
  const client = {
    rpc() {
      called = true;
      return Promise.resolve({ error: null });
    },
  };

  await recordScanRange(client, {
    connection_id: CONN_ID,
    app_user_id: CALLER,
    last_block_scanned: 900_100,
  });

  assertEquals(called, false);
});

Deno.test('a rejected range is logged, not thrown, and classified as rejected: the cursor write must stand', async () => {
  const client = {
    rpc() {
      // What an ownership rejection from the database looks like here: BOTH
      // the P0001 code and the ownership marker in the message. Either one
      // missing makes classifyScanRangeError call this 'failed' instead, per
      // the discriminating cases below.
      return Promise.resolve({
        error: {
          code: 'P0001',
          message: 'record_stealth_scan_range: caller does not own connection',
        },
      });
    },
  };

  // Must not throw AND must be classified as rejected. "Does not throw" alone
  // proves nothing here: recordScanRange never throws by design, so every
  // outcome, including a broken deployment, satisfies that alone.
  const outcome = await recordScanRange(client, {
    connection_id: CONN_ID,
    app_user_id: CALLER,
    last_block_scanned: 900_100,
    from_height: 900_000,
  });
  assertEquals(outcome.status, 'rejected');
});

/**
 * classifyScanRangeError, tested directly. These are the four cases DL-1663
 * itself named as indistinguishable before this fix: an ownership rejection
 * must stay quiet, and PGRST202, 42501 and a code-less error must all read
 * loud. A test that only checks "does not throw" cannot tell these apart,
 * which is exactly how the original defect (a broken deployment reading as a
 * healthy sync) went unseen for ten weeks.
 */

Deno.test('classifyScanRangeError: P0001 + ownership marker is rejected (the only quiet case)', () => {
  const outcome = classifyScanRangeError({
    code: 'P0001',
    message: 'record_stealth_scan_range: caller user-x does not own connection conn-y',
  });
  assertEquals(outcome.status, 'rejected');
  assertEquals(outcome.code, 'P0001');
});

Deno.test('classifyScanRangeError: PGRST202 (missing/mismatched function, a broken deployment) is failed', () => {
  const outcome = classifyScanRangeError({
    code: 'PGRST202',
    message: 'Could not find the function public.record_stealth_scan_range(...) in the schema cache',
  });
  assertEquals(outcome.status, 'failed');
  assertEquals(outcome.code, 'PGRST202');
});

Deno.test('classifyScanRangeError: 42501 (permission denied) is failed', () => {
  const outcome = classifyScanRangeError({
    code: '42501',
    message: 'permission denied for function record_stealth_scan_range',
  });
  assertEquals(outcome.status, 'failed');
  assertEquals(outcome.code, '42501');
});

Deno.test('classifyScanRangeError: no code at all is failed with UNKNOWN_ERROR_CODE, never mistaken for rejected', () => {
  const outcome = classifyScanRangeError({
    message: 'record_stealth_scan_range: caller does not own connection',
  });
  assertEquals(outcome.status, 'failed');
  assertEquals(outcome.code, UNKNOWN_ERROR_CODE);
});

Deno.test("classifyScanRangeError: P0001 from the guard's OTHER branch (connection not found) is failed, not rejected", () => {
  const outcome = classifyScanRangeError({
    code: 'P0001',
    message: 'record_stealth_scan_range: connection conn-y not found or has no owner',
  });
  assertEquals(outcome.status, 'failed');
  assertEquals(outcome.code, 'P0001');
});

Deno.test('opt-out boundary: from_height past last_block_scanned does not record', () => {
  assertEquals(
    buildScanRangeArgs({
      connection_id: CONN_ID,
      app_user_id: CALLER,
      last_block_scanned: 900_000,
      from_height: 900_001,
    }),
    null,
  );
});

Deno.test('opt-out boundary: negative and non-integer from_height do not record', () => {
  assertEquals(
    buildScanRangeArgs({
      connection_id: CONN_ID,
      app_user_id: CALLER,
      last_block_scanned: 900_100,
      from_height: -1,
    }),
    null,
  );
  assertEquals(
    buildScanRangeArgs({
      connection_id: CONN_ID,
      app_user_id: CALLER,
      last_block_scanned: 900_100,
      from_height: 900_000.5,
    }),
    null,
  );
});

Deno.test('records at the boundary: single-block scan (from == to) is legitimate', () => {
  const args = buildScanRangeArgs({
    connection_id: CONN_ID,
    app_user_id: CALLER,
    last_block_scanned: 900_000,
    from_height: 900_000,
  });
  assertEquals(args?.p_from_height, 900_000);
  assertEquals(args?.p_to_height, 900_000);
});

Deno.test('records at the boundary: from_height 0 is a genesis-start scan, not a missing value', () => {
  const args = buildScanRangeArgs({
    connection_id: CONN_ID,
    app_user_id: CALLER,
    last_block_scanned: 900_100,
    from_height: 0,
  });
  assertEquals(args?.p_from_height, 0);
  assertEquals(args?.p_app_user_id, CALLER);
});

/**
 * OR-T1953: buildScanRangeArgs returns null for two different causes that a
 * caller could not tell apart, and recordScanRange used to drop that null on
 * the floor with no log line at all. These tests prove the two causes are
 * distinguishable (classifySkipReason) and that recordScanRange now logs one
 * line naming which cause applied, for each cause separately.
 */

Deno.test('classifySkipReason: malformed from_height (missing, non-integer, negative)', () => {
  const base = { connection_id: CONN_ID, app_user_id: CALLER, last_block_scanned: 900_100 };
  assertEquals(classifySkipReason(base), 'malformed');
  assertEquals(classifySkipReason({ ...base, from_height: -1 }), 'malformed');
  assertEquals(classifySkipReason({ ...base, from_height: 900_000.5 }), 'malformed');
});

Deno.test('classifySkipReason: well-formed from_height above last_block_scanned is out-of-range', () => {
  assertEquals(
    classifySkipReason({
      connection_id: CONN_ID,
      app_user_id: CALLER,
      last_block_scanned: 900_000,
      from_height: 900_001,
    }),
    'out-of-range',
  );
});

Deno.test('recordScanRange logs the malformed cause and never calls the RPC', async () => {
  const logs: unknown[][] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    logs.push(args);
  };
  try {
    const client = {
      rpc() {
        throw new Error('must not be called: a malformed request should never reach the RPC');
      },
    };

    const outcome = await recordScanRange(client, {
      connection_id: CONN_ID,
      app_user_id: CALLER,
      last_block_scanned: 900_100,
      from_height: -1,
    });

    assertEquals(outcome.status, 'skipped');
    assertEquals(logs.length, 1, 'exactly one log line must fire for the skip');
    const line = String(logs[0][0]);
    assertEquals(line.includes('reason=malformed'), true, `expected reason=malformed in: ${line}`);
  } finally {
    console.info = originalInfo;
  }
});

Deno.test('recordScanRange logs the out-of-range cause and never calls the RPC', async () => {
  const logs: unknown[][] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    logs.push(args);
  };
  try {
    const client = {
      rpc() {
        throw new Error('must not be called: an out-of-range request should never reach the RPC');
      },
    };

    const outcome = await recordScanRange(client, {
      connection_id: CONN_ID,
      app_user_id: CALLER,
      last_block_scanned: 900_000,
      from_height: 900_001,
    });

    assertEquals(outcome.status, 'skipped');
    assertEquals(logs.length, 1, 'exactly one log line must fire for the skip');
    const line = String(logs[0][0]);
    assertEquals(
      line.includes('reason=out-of-range'),
      true,
      `expected reason=out-of-range in: ${line}`,
    );
  } finally {
    console.info = originalInfo;
  }
});
