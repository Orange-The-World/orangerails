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

/** Why buildScanRangeArgs declined to build RPC args, named so a caller can log it. */
export type ScanRangeSkipReason =
  | 'malformed'
  | 'range_exceeds_last_block_scanned';

export type ScanRangeDecision =
  | { ok: true; args: ScanRangeRpcArgs }
  | { ok: false; reason: ScanRangeSkipReason };

/**
 * Decide whether this request records a scan range, and build the RPC payload.
 *
 * Returns { ok: false } for two DIFFERENT reasons, named so the caller can
 * log which one fired instead of collapsing both into a silent no-op:
 *   'malformed'                          from_height missing, not an
 *                                         integer, or negative. This is the
 *                                         documented opt-out: those callers
 *                                         get cursor-only behaviour (DL-1478).
 *   'range_exceeds_last_block_scanned'   a well-formed from_height that is
 *                                         above last_block_scanned.
 * Neither case is recorded: no row is written for either. The caller must
 * not treat { ok: false } as "nothing to report".
 *
 * p_app_user_id is req.app_user_id, the caller identity, never a value read
 * back from stealth_connections.
 */
export function buildScanRangeArgs(req: ScanRangeRequest): ScanRangeDecision {
  const from = req.from_height;
  if (
    from === undefined ||
    typeof from !== 'number' ||
    !Number.isInteger(from) ||
    from < 0
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (from > req.last_block_scanned) {
    return { ok: false, reason: 'range_exceeds_last_block_scanned' };
  }

  return {
    ok: true,
    args: {
      p_connection_id: req.connection_id,
      p_from_height: from,
      p_to_height: req.last_block_scanned,
      p_app_user_id: req.app_user_id,
    },
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
 *
 * A declined range (ok: false) is ALSO logged, naming the reason
 * (buildScanRangeArgs' ScanRangeSkipReason), so a hole in the coverage table
 * can later be told apart from "this range was never scanned" versus "this
 * range was scanned and the record was declined", and why.
 */
// deno-lint-ignore no-explicit-any
export async function recordScanRange(client: any, req: ScanRangeRequest): Promise<void> {
  const decision = buildScanRangeArgs(req);
  if (!decision.ok) {
    console.error(
      `[or-stealth-envelope-update] scan range not recorded (${decision.reason}):`,
      {
        connection_id: req.connection_id,
        from_height: req.from_height,
        last_block_scanned: req.last_block_scanned,
      },
    );
    return;
  }

  const { error } = await client.rpc('record_stealth_scan_range', decision.args);
  if (error) {
    console.error('[or-stealth-envelope-update] record_stealth_scan_range failed:', error);
  }
}
