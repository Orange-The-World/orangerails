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
} from './scan_range.ts';

/**
 * A client whose rpc() always answers with one fixed error object, so each
 * case below drives exactly one error shape through recordScanRange.
 */
function clientRejectingWith(error: unknown) {
  return {
    rpc() {
      return Promise.resolve({ error });
    },
  };
}

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

/**
 * A request that always reaches the RPC (from_height present and in range).
 *
 * Declared AFTER CONN_ID and CALLER on purpose: module-level const initialisers
 * run top to bottom, so reading them from above would throw a ReferenceError at
 * load time and kill every test in this file.
 */
const RECORDING_REQUEST = {
  connection_id: CONN_ID,
  app_user_id: CALLER,
  last_block_scanned: 900_100,
  from_height: 900_000,
};

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

// ---------------------------------------------------------------------------
// Error classification (DL-1663).
//
// Before this, every error was logged and swallowed, so a broken deployment
// and a legitimately rejected range produced identical observable behaviour.
// These cases exist to make the two impossible to confuse again.
// ---------------------------------------------------------------------------

/**
 * The exact text the guard raises. Taken from the deployed function body on
 * dev, not from our own source: 'record_stealth_scan_range: caller % does not
 * own connection %'.
 */
const OWNERSHIP_REJECTION = {
  code: 'P0001',
  message:
    'record_stealth_scan_range: caller user-making-the-request does not own connection bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
};

Deno.test('an ownership rejection is still swallowed: the cursor write must stand', async () => {
  const outcome = await recordScanRange(
    clientRejectingWith(OWNERSHIP_REJECTION),
    RECORDING_REQUEST,
  );

  // Must not throw and must not be reported as a failure. The preceding cursor
  // write is the safe fallback (DL-1478) and nothing was written by the
  // rejected call. A change that makes this 'failed' would fail real customer
  // syncs and is a regression, not a stricter check.
  assertEquals(outcome.status, 'rejected');
  assertEquals(outcome.code, 'P0001');
});

Deno.test('PGRST202 is NOT swallowed: a missing or mismatched function is a broken deployment', async () => {
  // This is the error that actually shipped: the 4-arg caller went out while
  // the database still held the 3-arg function, every range write failed, and
  // the sync read green.
  const outcome = await recordScanRange(
    clientRejectingWith({
      code: 'PGRST202',
      message:
        'Could not find the function public.record_stealth_scan_range(p_app_user_id, p_connection_id, p_from_height, p_to_height) in the schema cache',
    }),
    RECORDING_REQUEST,
  );

  assertEquals(outcome.status, 'failed');
  assertEquals(outcome.code, 'PGRST202');
  assertNotEquals(outcome.status, 'rejected');
});

Deno.test('42501 is NOT swallowed: a revoked grant is not a rejected range', async () => {
  const outcome = await recordScanRange(
    clientRejectingWith({
      code: '42501',
      message: 'permission denied for function record_stealth_scan_range',
    }),
    RECORDING_REQUEST,
  );

  assertEquals(outcome.status, 'failed');
  assertEquals(outcome.code, '42501');
});

Deno.test('an unrecognised error code is loud BY DEFAULT, so nothing joins the quiet set by omission', async () => {
  const outcome = await recordScanRange(
    clientRejectingWith({ code: '08006', message: 'connection failure' }),
    RECORDING_REQUEST,
  );

  assertEquals(outcome.status, 'failed');
  assertEquals(outcome.code, '08006');
});

Deno.test("the guard's OTHER P0001 is loud: matching on the errcode alone is not enough", () => {
  // record_stealth_scan_range raises P0001 twice. Only one of them is an
  // ownership rejection. This one means the connection row vanished between
  // the handler's own read and this call, which is worth surfacing.
  const outcome = classifyScanRangeError({
    code: 'P0001',
    message:
      'record_stealth_scan_range: connection bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb not found or has no owner',
  });

  assertEquals(outcome.status, 'failed');
});

Deno.test('an error carrying no code at all is loud, reported as unknown', () => {
  const outcome = classifyScanRangeError({ message: 'something went wrong' });

  assertEquals(outcome.status, 'failed');
  assertEquals(outcome.code, 'unknown');
});

Deno.test('the ownership message alone does not buy silence: the errcode must match too', () => {
  const outcome = classifyScanRangeError({
    message: 'record_stealth_scan_range: caller does not own connection',
  });

  assertEquals(outcome.status, 'failed');
});

Deno.test('a successful write reports recorded, and an opt-out reports skipped', async () => {
  const ok = {
    rpc() {
      return Promise.resolve({ error: null });
    },
  };

  assertEquals((await recordScanRange(ok, RECORDING_REQUEST)).status, 'recorded');

  assertEquals(
    (await recordScanRange(ok, {
      connection_id: CONN_ID,
      app_user_id: CALLER,
      last_block_scanned: 900_100,
    })).status,
    'skipped',
  );
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
