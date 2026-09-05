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

/**
 * True when from_height itself cannot be used: missing, not a number, not an
 * integer, or negative. Deliberately does NOT check it against
 * last_block_scanned -- that is a separate, well-formed-but-out-of-range
 * rejection (see buildScanRangeArgs below), and recordScanRange logs the two
 * causes distinctly because they mean different things to someone debugging a
 * coverage gap (OR-T1953).
 */
export function isMalformedFromHeight(from: unknown): boolean {
  return (
    from === undefined ||
    typeof from !== 'number' ||
    !Number.isInteger(from) ||
    from < 0
  );
}

/**
 * Decide whether this request records a scan range, and build the RPC payload.
 *
 * Returns null when the caller supplied no usable from_height, which is the
 * documented opt-out: those callers get cursor-only behaviour (DL-1478). A
 * null return means the range is NOT recorded at all: not deferred, not
 * retried, simply skipped. recordScanRange logs which of the two rejection
 * causes applied (malformed from_height, or a well-formed from_height that
 * exceeds last_block_scanned) so that a later coverage gap can be explained
 * (OR-T1953).
 *
 * p_app_user_id is req.app_user_id, the caller identity, never a value read
 * back from stealth_connections.
 */
export function buildScanRangeArgs(req: ScanRangeRequest): ScanRangeRpcArgs | null {
  const from = req.from_height;
  if (isMalformedFromHeight(from)) return null;
  if ((from as number) > req.last_block_scanned) return null;

  return {
    p_connection_id: req.connection_id,
    p_from_height: from as number,
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
 *
 * When buildScanRangeArgs returns null the range is not recorded at all, and
 * this now logs which of the two causes applied (OR-T1953): a malformed
 * from_height (missing, non-integer, or negative), or a well-formed
 * from_height that exceeds last_block_scanned. Before this, that case logged
 * nothing, so a coverage hole could not be told apart from a range that was
 * never scanned in the first place.
 */
// deno-lint-ignore no-explicit-any
export async function recordScanRange(client: any, req: ScanRangeRequest): Promise<void> {
  const args = buildScanRangeArgs(req);
  if (args === null) {
    if (isMalformedFromHeight(req.from_height)) {
      console.warn(
        '[or-stealth-envelope-update] scan range not recorded: from_height is malformed (missing, non-integer, or negative):',
        req.from_height,
      );
    } else {
      console.warn(
        '[or-stealth-envelope-update] scan range not recorded: from_height exceeds last_block_scanned:',
        req.from_height,
        '>',
        req.last_block_scanned,
      );
    }
    return;
  }

  const { error } = await client.rpc('record_stealth_scan_range', args);
  if (error) {
    console.error('[or-stealth-envelope-update] record_stealth_scan_range failed:', error);
  }
}
