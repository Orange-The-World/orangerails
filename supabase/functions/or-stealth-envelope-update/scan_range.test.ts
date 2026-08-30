/**
 * Deno tests for scan-range recording (DEV-0136, DL-1478, DL-1597).
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/or-stealth-envelope-update/scan_range.test.ts
 *
 * WHAT THIS FILE IS FOR. recordScanRange swallows every failure by design: a
 * rejected range must not fail a customer's sync. The swallow is correct and
 * these tests do not challenge it. What they pin is that the failure still
 * LEAVES the module by two routes that something can observe, because before
 * DEV-0136 it left by neither: the log line nothing alerts on was the only
 * trace, and the handler's response was identical whether the range was
 * written or lost.
 *
 * So the discriminating cases here are the ones that fail if the reporting or
 * the returned outcome is taken back out. A test that only asserted "it did
 * not throw" would pass just as happily against the code this change replaces,
 * which is the exact shape of check that let this go unnoticed.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { errorClassName } from '../_shared/upstream-errors.ts';
import {
  buildScanRangeArgs,
  recordScanRange,
  scanRangeReportError,
  type ScanRangeReporter,
  type ScanRangeRequest,
} from './scan_range.ts';

const CONNECTION_ID = '11111111-2222-4333-8444-555555555555';
const APP_USER_ID = 'host-app-user-9f2c';

/** A request that DOES ask for a range to be recorded. */
function req(over: Partial<ScanRangeRequest> = {}): ScanRangeRequest {
  return {
    connection_id: CONNECTION_ID,
    app_user_id: APP_USER_ID,
    last_block_scanned: 800_010,
    from_height: 800_000,
    ...over,
  };
}

interface RpcCall {
  name: string;
  args: unknown;
}

/**
 * Minimal stand-in for the supabase client. Records what it was called with so
 * a test can assert the RPC did NOT fire on the skip paths: "returned skipped"
 * and "wrote nothing" are different claims and only the second one matters.
 */
function fakeClient(result: { error: unknown }, calls: RpcCall[]) {
  return {
    rpc(name: string, args: unknown) {
      calls.push({ name, args });
      return Promise.resolve(result);
    },
  };
}

interface Reported {
  err: unknown;
  fnName: string;
}

function collectingReporter(into: Reported[]): ScanRangeReporter {
  return (err, fnName) => {
    into.push({ err, fnName });
  };
}

/** Run body with console.error captured, so the suite output stays readable
 *  and the log line itself can be asserted. */
async function withCapturedErrorLog(
  body: (lines: unknown[][]) => Promise<void>,
): Promise<void> {
  const lines: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args);
  };
  try {
    await body(lines);
  } finally {
    console.error = original;
  }
}

// ---------------------------------------------------------------------------
// The opt-out and the near miss, which must not look the same.
// ---------------------------------------------------------------------------

Deno.test('no from_height is the documented opt-out: skipped, and nothing is written', async () => {
  const calls: RpcCall[] = [];
  const reported: Reported[] = [];
  const outcome = await recordScanRange(
    fakeClient({ error: null }, calls),
    req({ from_height: undefined }),
    collectingReporter(reported),
  );

  assertEquals(outcome, 'skipped');
  assertEquals(calls.length, 0, 'the RPC must not fire when no range was asked for');
  assertEquals(reported.length, 0, 'an opt-out is not a failure and must not be reported');
});

Deno.test('an unusable from_height is invalid, NOT skipped', async () => {
  // Every one of these is a caller that believes it is recording a range and
  // is not. Reporting them as "skipped" would file them under the deliberate
  // opt-out and hide them, which is the failure mode DEV-0136 is about.
  const unusable: Array<[string, Partial<ScanRangeRequest>]> = [
    ['above the scan tip', { from_height: 800_011, last_block_scanned: 800_010 }],
    ['negative', { from_height: -1 }],
    ['not an integer', { from_height: 800_000.5 }],
  ];

  for (const [label, over] of unusable) {
    const calls: RpcCall[] = [];
    const reported: Reported[] = [];
    const outcome = await recordScanRange(
      fakeClient({ error: null }, calls),
      req(over),
      collectingReporter(reported),
    );
    assertEquals(outcome, 'invalid', `from_height ${label} must report as invalid`);
    assertEquals(calls.length, 0, `from_height ${label} must not reach the database`);
  }
});

// ---------------------------------------------------------------------------
// The happy path.
// ---------------------------------------------------------------------------

Deno.test('a clean RPC is recorded, and carries the CALLER identity', async () => {
  const calls: RpcCall[] = [];
  const reported: Reported[] = [];
  const outcome = await recordScanRange(
    fakeClient({ error: null }, calls),
    req(),
    collectingReporter(reported),
  );

  assertEquals(outcome, 'recorded');
  assertEquals(reported.length, 0);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].name, 'record_stealth_scan_range');
  // DL-1597: p_app_user_id must be the value the caller sent, never one read
  // back from the connection row, or the ownership guard compares the owner
  // against itself and can never fail.
  assertEquals(calls[0].args, {
    p_connection_id: CONNECTION_ID,
    p_from_height: 800_000,
    p_to_height: 800_010,
    p_app_user_id: APP_USER_ID,
  });
  // buildScanRangeArgs is the single source of that payload; pinned here so a
  // change to it cannot pass by only editing the caller.
  assertEquals(buildScanRangeArgs(req()), calls[0].args);
});

// ---------------------------------------------------------------------------
// The failure path. These are the assertions that fail if the change is
// reverted.
// ---------------------------------------------------------------------------

Deno.test('a failed RPC is reported, returns failed, and does not throw', async () => {
  await withCapturedErrorLog(async (lines) => {
    const calls: RpcCall[] = [];
    const reported: Reported[] = [];

    const outcome = await recordScanRange(
      fakeClient({ error: { code: '42501', message: 'permission denied for function' } }, calls),
      req(),
      collectingReporter(reported),
    );

    // The swallow holds: reaching this line at all is half the assertion.
    assertEquals(outcome, 'failed');

    assertEquals(reported.length, 1, 'a swallowed failure must still be reported');
    assertEquals(reported[0].fnName, 'or-stealth-envelope-update');

    const err = reported[0].err as Error;
    assertEquals(err.message, 'record_stealth_scan_range failed (sqlstate 42501)');
    // The tracker groups on this type. errorClassName is what _shared/sentry.ts
    // puts in the event, so assert through it rather than reading .name here.
    assertEquals(errorClassName(err), 'ScanRangeRecordFailed');

    // The log keeps the detail the tracker deliberately does not get.
    assertEquals(lines.length, 1);
    assertEquals(lines[0][1], CONNECTION_ID);
  });
});

Deno.test('the database message never reaches the error tracker', async () => {
  await withCapturedErrorLog(async () => {
    const reported: Reported[] = [];
    // The real text of the ownership raise. It interpolates BOTH the caller's
    // app_user_id and the connection id, and app_user_id is a host app's
    // identifier for one of its end users.
    const dbError = {
      code: 'P0001',
      message:
        `record_stealth_scan_range: caller ${APP_USER_ID} does not own connection ${CONNECTION_ID}`,
    };

    await recordScanRange(
      fakeClient({ error: dbError }, []),
      req(),
      collectingReporter(reported),
    );

    const text = String((reported[0].err as Error).message);
    assertEquals(
      text.includes(APP_USER_ID),
      false,
      'the end-user identifier must never reach the error tracker',
    );
    assertEquals(
      text.includes(CONNECTION_ID),
      false,
      'the connection id belongs in the function log, not in the tracker event',
    );
    assertEquals(text, 'record_stealth_scan_range failed (sqlstate P0001)');
  });
});

Deno.test('an error with no code still produces a groupable report', async () => {
  // A transport-level failure from the client carries no SQLSTATE. It must
  // still report, and must still land in one bucket rather than a new issue
  // per occurrence.
  const a = scanRangeReportError({ message: 'error sending request' });
  const b = scanRangeReportError(null);
  assertEquals(a.message, 'record_stealth_scan_range failed (sqlstate unknown)');
  assertEquals(b.message, a.message, 'identical causes must produce an identical message');
  assertEquals(errorClassName(a), 'ScanRangeRecordFailed');
});
