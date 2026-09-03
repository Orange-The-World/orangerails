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
 * Decide whether this request records a scan range, and build the RPC payload.
 *
 * Returns null when the caller supplied no usable from_height, which is the
 * documented opt-out: those callers get cursor-only behaviour (DL-1478).
 *
 * p_app_user_id is req.app_user_id, the caller identity, never a value read
 * back from stealth_connections.
 */
/**
 * OR-T1177: to_height (req.last_block_scanned) and from_height are passed
 * through to record_stealth_scan_range with only the shape checks below --
 * both non-negative integers, from <= to. Neither is checked against
 * anything the server independently knows was scanned. I read the RPC
 * itself (public.record_stealth_scan_range, dev project): it verifies
 * connection ownership and merges the new interval with any overlapping
 * ones already stored; it applies no bound of its own either.
 *
 * This is the more consequential half of the OR-T1177 finding, worse than
 * the cursor gap in advanceCursor (see that module's comment): per
 * OR-T1162/OR-T1172 a stealth_scan_ranges row can be the value that decides
 * where a sync resumes, AHEAD of last_block_scanned. A false interval
 * recorded here is believed at face value and the gap inside it never
 * closes.
 *
 * I looked for a bound to add and could not find one that survives the
 * gap-fill case sync.tsx already relies on: filledBelow deliberately sends a
 * to_height BELOW the currently stored cursor to record ground scanned
 * earlier than the cursor's current position. Any check of the shape
 * "to_height must not be behind the stored cursor" rejects that legitimate
 * call along with the bad one it is meant to catch. A bound that is actually
 * correct here needs a source of truth this module does not have: an
 * independent reference for how far the chain has really progressed. That is
 * a real, separate piece of infrastructure, not a one-line fix.
 *
 * THAT DECISION IS MADE, on OR-T1185 (CTO, 2026-08-31), and this comment is
 * the record of it. Building the chain-height reference was REJECTED: it
 * bounds the wrong axis, because it can only establish that a claimed height
 * is PLAUSIBLE and never that it is TRUE, and a plausible false claim is
 * exactly the harm; and it would put an external availability dependency in
 * front of a write production depends on. The unbounded coverage interval is
 * ACCEPTED instead.
 *
 * THE ACCEPTANCE IS CONDITIONAL, and the condition is what makes it
 * survivable rather than permanent: a user-triggered rescan must clear the
 * stealth_scan_ranges rows as well as the cursor, so a false interval can be
 * repaired instead of believed forever. That recovery path was broken when
 * this was written and is tracked on OR-T1203. If OR-T1203 is reverted, or
 * closed without a rescan that actually clears coverage, this acceptance no
 * longer holds and this paragraph stops being true. Say so rather than
 * leaving it standing.
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
// deno-lint-ignore no-explicit-any
export async function recordScanRange(client: any, req: ScanRangeRequest): Promise<void> {
  const args = buildScanRangeArgs(req);
  if (args === null) return;

  const { error } = await client.rpc('record_stealth_scan_range', args);
  if (error) {
    console.error('[or-stealth-envelope-update] record_stealth_scan_range failed:', error);
  }
}
