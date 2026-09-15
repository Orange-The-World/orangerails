/**
 * Scan-range recording for or-stealth-envelope-update (DL-1478, DL-1597, DL-1663).
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
 * WHY THE ERRORS ARE CLASSIFIED RATHER THAN ALL SWALLOWED (DL-1663).
 *
 * The first version of this module logged every RPC error and carried on. That
 * is the right behaviour for one case and the wrong behaviour for every other
 * case, and nothing outside the function could tell the two apart.
 *
 *   Expected, and still swallowed: the guard's own ownership rejection. It
 *   raises with ERRCODE P0001 and a message containing "does not own
 *   connection". Nothing is written, the preceding cursor write is the safe
 *   fallback, and the caller's sync is fine (DL-1478).
 *
 *   NOT expected, and now loud:
 *     PGRST202  the function does not exist with those argument names. That is
 *               a broken deployment, not a rejected request. It happened: the
 *               4-arg caller shipped while the database still held the 3-arg
 *               function, every range write failed, and the sync read green.
 *     42501     permission denied, i.e. a grant moved underneath us.
 *     anything else, including a P0001 raised by the guard's OTHER branch
 *               ("connection ... not found or has no owner"), which means the
 *               row vanished between the handler's own read and this call.
 *
 * The default is loud on purpose. An error code nobody has classified yet must
 * not silently join the swallowed set: that is precisely how the original
 * defect survived unnoticed.
 */

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
 * The parts of a PostgREST error object this module classifies on. Both fields
 * are optional because an error object that carries neither is a real shape we
 * have to handle, and it must not be mistaken for an expected rejection.
 */
export interface ScanRangeRpcError {
  code?: string;
  message?: string;
}

/**
 * An RPC error, sorted into the only two buckets that matter.
 *
 * rejected: the database refused the range on ownership grounds. Expected,
 *           nothing was written, the sync continues.
 * failed:   anything else. The deployment or the grants are wrong, and the
 *           caller must be able to see that.
 */
export type ScanRangeFailure =
  | { status: 'rejected'; code: string }
  | { status: 'failed'; code: string; message: string };

/** The full set of outcomes recordScanRange can report. */
export type ScanRangeOutcome =
  | { status: 'skipped' }
  | { status: 'recorded' }
  | ScanRangeFailure;

/** ERRCODE the guard raises with. Both of its RAISE branches use it. */
export const OWNERSHIP_REJECTION_ERRCODE = 'P0001';

/**
 * The fragment that separates the guard's ownership rejection from its other
 * P0001, which reports a connection that is missing or has no owner. Only the
 * ownership rejection is expected here: the handler has already read and
 * checked the row, so "not found" at this point means it disappeared underneath
 * us and is worth surfacing.
 */
const OWNERSHIP_REJECTION_MARKER = 'does not own connection';

/** Reported when the error object carries no code at all. */
export const UNKNOWN_ERROR_CODE = 'unknown';

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
 * Sort an RPC error into rejected (expected, swallow) or failed (loud).
 *
 * Exported so the classification can be tested directly rather than only
 * through a fake client. The rule is narrow by design: both the code AND the
 * message must match the guard's ownership rejection. Anything else is a
 * failure, so a new error code cannot join the quiet set by accident.
 */
export function classifyScanRangeError(
  error: ScanRangeRpcError | null | undefined,
): ScanRangeFailure {
  const rawCode = error && typeof error.code === 'string' ? error.code : '';
  const code = rawCode.length > 0 ? rawCode : UNKNOWN_ERROR_CODE;
  const message = error && typeof error.message === 'string' ? error.message : '';

  if (code === OWNERSHIP_REJECTION_ERRCODE && message.includes(OWNERSHIP_REJECTION_MARKER)) {
    return { status: 'rejected', code };
  }

  return { status: 'failed', code, message };
}

/**
 * Record the scan range for this request, if it carries one.
 *
 * Returns the outcome rather than void so the handler can surface a failure.
 * An ownership rejection is logged at info and swallowed, which is the
 * behaviour DL-1478 requires: the cursor write that precedes this is the safe
 * fallback and a rejected range must not fail the caller's sync. Every other
 * error is logged at error WITH ITS CODE, because a generic "failed" line
 * cannot be triaged and is what let a broken deployment read as a healthy sync.
 */
// deno-lint-ignore no-explicit-any
export async function recordScanRange(client: any, req: ScanRangeRequest): Promise<ScanRangeOutcome> {
  const args = buildScanRangeArgs(req);
  if (args === null) return { status: 'skipped' };

  const { error } = await client.rpc('record_stealth_scan_range', args);
  if (!error) return { status: 'recorded' };

  const outcome = classifyScanRangeError(error as ScanRangeRpcError);

  if (outcome.status === 'rejected') {
    console.info(
      `[or-stealth-envelope-update] record_stealth_scan_range rejected the range (code=${outcome.code}): caller does not own this connection. Nothing written, cursor write stands.`,
    );
    return outcome;
  }

  console.error(
    `[or-stealth-envelope-update] record_stealth_scan_range FAILED code=${outcome.code}: ${outcome.message}`,
  );
  return outcome;
}
