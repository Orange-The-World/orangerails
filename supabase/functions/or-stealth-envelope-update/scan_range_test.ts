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
  recordScanRange,
  reportScanRangeOutcome,
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

Deno.test('a rejected range is logged, not thrown: the cursor write must stand', async () => {
  const client = {
    rpc() {
      // What an ownership rejection from the database looks like here.
      return Promise.resolve({
        error: { message: 'record_stealth_scan_range: caller does not own connection' },
      });
    },
  };

  // Must not throw. The preceding cursor write is the safe fallback (DL-1478),
  // and nothing was written by the rejected call.
  await recordScanRange(client, {
    connection_id: CONN_ID,
    app_user_id: CALLER,
    last_block_scanned: 900_100,
    from_height: 900_000,
  });
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

// --- OR-T0645 / OR-C1710: a NON-ownership RPC failure must be loud, end to end ---
//
// The tests above cover the ownership rejection (P0001 + "does not own
// connection"): expected, swallowed, cursor write stands. Nothing before this
// ticket exercised the other branch: a grant moved, the function signature
// drifted, or anything else classifyScanRangeError has not been told to
// expect. That branch must reach the caller's response and Sentry, or a
// broken deployment reads as a healthy sync (this happened for real: OR-T0903).

/** A grant-mismatch error, the shape the DB actually raised when this failed in prod. */
const GRANT_ERROR = { code: '42501', message: 'permission denied for function record_stealth_scan_range' };

Deno.test('classifyScanRangeError: a grant failure is "failed", not "rejected"', () => {
  const outcome = classifyScanRangeError(GRANT_ERROR);
  assertEquals(outcome.status, 'failed');
  if (outcome.status === 'failed') {
    assertEquals(outcome.code, '42501');
    assertEquals(outcome.message, GRANT_ERROR.message);
  }
});

Deno.test('recordScanRange: a rejected RPC promise with a non-ownership code returns status "failed"', async () => {
  const client = { rpc: () => Promise.resolve({ error: GRANT_ERROR }) };

  const outcome = await recordScanRange(client, {
    connection_id: CONN_ID,
    app_user_id: CALLER,
    last_block_scanned: 900_100,
    from_height: 900_000,
  });

  assertEquals(outcome.status, 'failed');
});

Deno.test('reportScanRangeOutcome: a failed outcome reports exactly once, code only, and sets scan_range_failed', () => {
  const calls: Array<{ message: string; fnName: string }> = [];
  const req = new Request('https://example.com/or-stealth-envelope-update');

  const fields = reportScanRangeOutcome(
    { status: 'failed', code: '42501', message: 'permission denied for app_user_id 11111111-1111-1111-1111-111111111111' },
    'or-stealth-envelope-update',
    req,
    (err, fnName) => {
      calls.push({ message: err.message, fnName });
    },
  );

  assertEquals(calls.length, 1);
  assertEquals(calls[0].fnName, 'or-stealth-envelope-update');
  assertEquals(calls[0].message, 'record_stealth_scan_range failed: code=42501');
  // The driver message (which carried an app_user_id above) must never reach
  // the reported error. Only the code may leave the function.
  assertEquals(calls[0].message.includes('app_user_id'), false);
  assertEquals(fields, { scan_range_failed: { code: '42501' } });
});

Deno.test('reportScanRangeOutcome: recorded, rejected and skipped stay exactly as quiet as before this ticket', () => {
  const req = new Request('https://example.com/or-stealth-envelope-update');
  let reportCalled = false;
  const report = () => { reportCalled = true; };

  for (
    const outcome of [
      { status: 'recorded' as const },
      { status: 'rejected' as const, code: 'P0001' },
      { status: 'skipped' as const },
    ]
  ) {
    const fields = reportScanRangeOutcome(outcome, 'or-stealth-envelope-update', req, report);
    assertEquals(fields, {});
  }

  assertEquals(reportCalled, false);
});
