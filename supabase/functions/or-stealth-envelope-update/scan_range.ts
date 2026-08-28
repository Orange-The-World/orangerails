/**
 * Scan-range recording for or-stealth-envelope-update (DL-1478, DL-1597).
 *
 * WHY THIS IS ITS OWN MODULE, and why the signature is narrow on purpose.
 *
 * record_stealth_scan_range is SECURITY DEFINER. Its ownership guard reads the
 * owner from the stealth_connections row for p_connection_id and rejects unless
 * p_app_user_id matches it. That check is only real if p_app_user_id carries the
 * CALLER identity. If it is handed the value the handler just read from that
 * same row, the function compares the owner against itself, the comparison is
 * always equal, and the RAISE is unreachable. A check that cannot fail is not a
 * check.
 *
 * That is not a hypothetical: it is the defect this module exists to prevent
 * recurring. The handler has the connection row in scope a few lines above the
 * call, so reaching for row.app_user_id is the natural mistake. This function is
 * therefore given the request body and nothing else. The connection row is not
 * in its scope, so the wrong value cannot be passed without deliberately
 * widening this signature.
 *
 * The caller identity is safe to trust here because index.ts pins it to the
 * credential before this is reached: direct mode requires it to equal
 * ctx.userId, widget mode enforces it through enforceWidgetAppUser, and platform
 * mode scopes the connection read by platform_id.
 *
 * DEV-0136: WHY A SWALLOWED FAILURE IS NO LONGER INVISIBLE.
 *
 * The swallow below stays. A rejected range must not fail the caller's sync
 * (DL-1478) and nothing here reverses that. What changed is that the failure
 * can now be seen. Before, the only trace was a console.error line nothing
 * alerts on, the function still answered 200, and the response body was
 * identical whether a range was written or not, so "recorded 1 of 1" and
 * "recorded 0 of 1" could not be told apart from any direction.
 *
 * Two things distinguish them now:
 *   1. A failed RPC is reported through _shared/sentry.ts, the same reporter
 *      the handler is already wrapped in, so a rising rate is visible without
 *      changing what the caller sees.
 *   2. recordScanRange returns the outcome, so the handler can put a truthful
 *      flag in a response the caller is free to ignore.
 *
 * WHAT IS SENT TO THE ERROR TRACKER, and why it is not the database message.
 * record_stealth_scan_range raises with p_app_user_id and the connection id
 * interpolated into its message. app_user_id is a host app's identifier for
 * one of its end users, and _shared/sentry.ts sends no request body precisely
 * so identifiers like that never reach the tracker. So the report carries the
 * SQLSTATE code and nothing else. The code is what separates the causes
 * anyway: P0001 is our own ownership or missing-connection raise, 42501 a
 * missing EXECUTE grant, 22P02 a malformed argument, PGRST202 the function
 * missing from the schema cache. The full driver error and the connection id
 * still go to the function log, which is inside our boundary.
 */

import { reportError } from '../_shared/sentry.ts';

/** Exact argument list for the record_stealth_scan_range RPC (4-arg form). */
export interface ScanRangeRpcArgs {
  p_connection_id: string;
  p_from_height: number;
  p_to_height: number;
  p_app_user_id: string;
}

/**
 * The subset of the request body this module is allowed to see. Deliberately
 * does NOT include the connection row: see the module comment above.
 */
export interface ScanRangeRequest {
  connection_id: string;
  app_user_id: string;
  last_block_scanned: number;
  from_height?: number;
}

/**
 * Decide whether this request records a scan range, and build the RPC payload.
 *
 * Returns null when the caller supplied no usable from_height, which is the
 * documented opt-out: those callers get cursor-only behaviour (DL-1478).
 *
 * p_app_user_id is req.app_user_id, the caller identity, never a value read
 * back from stealth_connections.
 */
export function buildScanRangeArgs(req: ScanRangeRequest): ScanRangeRpcArgs | null {
  const from = req.from_height;
  if (
    from === undefined ||
    typeof from !== 'number' ||
    !Number.isInteger(from) ||
    from < 0 ||
    from > req.last_block_scanned
  ) {
    return null;
  }

  return {
    p_connection_id: req.connection_id,
    p_from_height: from,
    p_to_height: req.last_block_scanned,
    p_app_user_id: req.app_user_id,
  };
}

/**
 * What happened to the scan range on one request (DEV-0136).
 *
 *   'skipped'  No from_height was supplied. That is the documented opt-out
 *              (DL-1478) and the caller gets cursor-only behaviour.
 *   'invalid'  A from_height WAS supplied and could not be used: not an
 *              integer, negative, or above last_block_scanned. Kept separate
 *              from 'skipped' deliberately. A caller that believes it is
 *              recording ranges and silently is not is the exact failure this
 *              ticket is about, and one value for both facts reproduces it.
 *   'recorded' The RPC returned no error. record_stealth_scan_range either
 *              inserts the interval or merges it into the overlapping one on
 *              every path that does not raise, so no error means a row was
 *              written.
 *   'failed'   The RPC returned an error. Nothing was written. The caller's
 *              sync still succeeded, which is the point of the swallow.
 */
export type ScanRangeOutcome = 'skipped' | 'invalid' | 'recorded' | 'failed';

/**
 * How a swallowed failure leaves this module.
 *
 * Injectable for ONE reason: so a test can observe that the report happens at
 * all. Production always uses the default. A test that could only assert "it
 * did not throw" would pass just as happily with the reporting removed, which
 * is the shape of check this ticket exists to stop shipping.
 */
export type ScanRangeReporter = (err: unknown, fnName: string) => void;

const FN_NAME = 'or-stealth-envelope-update';

/**
 * Fire and forget, matching wrapSentryHandler: a slow error tracker must not
 * add latency to a sync that has already succeeded.
 */
const defaultReporter: ScanRangeReporter = (err, fnName) => {
  void reportError(err, fnName);
};

/**
 * Build the error the tracker sees.
 *
 * Named, so errorClassName() reports a distinct type and these group as their
 * own issue instead of joining the generic Error bucket. Worded so the message
 * is IDENTICAL for every occurrence of a given cause: the SQLSTATE is the only
 * variable, so the tracker counts a rate rather than fragmenting into one
 * issue per connection. Nothing here comes from the database's own message,
 * which carries the caller's app_user_id.
 */
export function scanRangeReportError(rpcError: unknown): Error {
  const code = (rpcError as { code?: unknown } | null)?.code;
  const codeText = typeof code === 'string' && code.length > 0 ? code : 'unknown';
  const err = new Error(`record_stealth_scan_range failed (sqlstate ${codeText})`);
  err.name = 'ScanRangeRecordFailed';
  return err;
}

/**
 * Record the scan range for this request, if it carries one.
 *
 * Failure is logged, reported and swallowed by design: the cursor write that
 * precedes this is the safe fallback while range recording is rolled out, so a
 * rejected range must not fail the caller's sync (DL-1478). Note that an
 * ownership rejection from the database lands here as a reported error, which
 * is the correct outcome: nothing is written, and now something can see it.
 *
 * Returns the outcome rather than void so the handler can tell the caller
 * which of the four things happened. It never throws.
 */
// deno-lint-ignore no-explicit-any
export async function recordScanRange(
  client: any,
  req: ScanRangeRequest,
  report: ScanRangeReporter = defaultReporter,
): Promise<ScanRangeOutcome> {
  const args = buildScanRangeArgs(req);
  if (args === null) {
    return req.from_height === undefined ? 'skipped' : 'invalid';
  }

  const { error } = await client.rpc('record_stealth_scan_range', args);
  if (error) {
    // The log line keeps the full driver error AND the connection id: it is
    // inside our boundary, so it is where triage of a single failure happens.
    // The tracker gets only the SQLSTATE, for the reason in the module header.
    console.error(
      '[or-stealth-envelope-update] record_stealth_scan_range failed for connection',
      args.p_connection_id,
      error,
    );
    return 'failed';
  }
  return 'recorded';
}
