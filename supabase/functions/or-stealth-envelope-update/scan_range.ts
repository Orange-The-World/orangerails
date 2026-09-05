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
 * Record the scan range for this request, if it carries one.
 *
 * Failure is logged and swallowed by design: the cursor write that precedes
 * this is the safe fallback while range recording is rolled out, so a rejected
 * range must not fail the caller's sync (DL-1478). Note that an ownership
 * rejection from the database lands here as a logged error, which is the
 * correct outcome: nothing is written.
 */
export interface ScanRangeResult {
  /** False when the request carried no from_height, so the RPC was never called. */
  attempted: boolean;
  /** True when the RPC returned no error. */
  recorded: boolean;
  /**
   * True when the RPC returned the guard's own P0001 ownership rejection.
   * This is an expected outcome, not a failure: the range legitimately does
   * not belong to this connection under the identity the guard resolved.
   */
  skippedOwnership?: boolean;
  /** Present only for an error that is NOT the ownership rejection. */
  errorCode?: string;
  errorMessage?: string;
}

const OWNERSHIP_REJECTION_PREFIX = 'record_stealth_scan_range: caller ';
const OWNERSHIP_REJECTION_SUBSTRING = 'does not own connection';

// deno-lint-ignore no-explicit-any
export async function recordScanRange(client: any, req: ScanRangeRequest): Promise<ScanRangeResult> {
  const args = buildScanRangeArgs(req);
  if (args === null) return { attempted: false, recorded: false };

  const { error } = await client.rpc('record_stealth_scan_range', args);
  if (!error) return { attempted: true, recorded: true };

  const isOwnershipRejection =
    error.code === 'P0001' &&
    typeof error.message === 'string' &&
    error.message.startsWith(OWNERSHIP_REJECTION_PREFIX) &&
    error.message.includes(OWNERSHIP_REJECTION_SUBSTRING);

  if (isOwnershipRejection) {
    console.info(
      '[or-stealth-envelope-update] record_stealth_scan_range: ownership rejection, range not recorded',
    );
    return { attempted: true, recorded: false, skippedOwnership: true };
  }

  // Anything else (PGRST202 = function missing or wrong signature, 42501 =
  // permission denied, or any other code) is NOT the expected guard outcome.
  // Swallowing it the same way is exactly what let a broken RPC read as a
  // healthy sync. Log the code itself, since the message alone does not tell
  // a human which of those it was.
  console.error('[or-stealth-envelope-update] record_stealth_scan_range failed:', {
    code: error.code,
    message: error.message,
  });
  return {
    attempted: true,
    recorded: false,
    errorCode: error.code,
    errorMessage: error.message,
  };
}
