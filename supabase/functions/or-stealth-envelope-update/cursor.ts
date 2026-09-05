/**
 * advanceCursor -- atomically advance last_block_scanned for a stealth connection.
 *
 * WHAT THE INCOMING NUMBER MEANS. The contract for this column is defined once,
 * in ../_shared/scan-cursor.ts, and both endpoints that write it import from
 * there: last_block_scanned is the last height the CALLER SCANNED CONTIGUOUSLY,
 * never a chain tip and never the height of the highest transaction it matched.
 * Read that module before changing anything here. Until OR-T1914 this file's
 * sibling enforced that rule and this one's header called the same field "the
 * scan tip", which is how a single column ended up with two contracts.
 *
 * THE CEILING (OR-T1914). A caller that can tell its tip from its contiguous
 * height sends clientContiguousScanned as well, and the write is capped at
 * min(incomingHeight, clientContiguousScanned). It is a ceiling only: it can
 * hold the cursor back, never push it forward, so the DL-0419 forward-only
 * guarantee is untouched. It is optional because a caller whose posted height
 * already is its contiguous height has nothing to add by repeating it, and
 * because an existing caller must not start failing.
 *
 * Honest limit, stated so nobody reads more protection into this than is here:
 * the server holds no independent record of what a caller read, so it cannot
 * catch a caller that simply reports a tip in last_block_scanned and sends no
 * ceiling. What it can do is refuse to let a second number raise the cursor,
 * and that is what this does.
 *
 * THE FENCE (OR-T2457). The forward-only guard below is `last_block_scanned
 * IS NULL OR last_block_scanned < boundedHeight`, and applyEnvelopeReplacement
 * sets last_block_scanned to NULL on every reset, so on its own that guard
 * treats a just-reset connection exactly like a brand new one: anything may
 * write. A write queued before the reset, from a sync of the OLD envelope,
 * used to sail through and put the pre-reset height back, silently
 * defeating the rescan the reset exists to trigger. scanGeneration closes
 * that: it is REQUIRED, not optional like the ceiling above, because unlike
 * a caller lying about its own scan tip, a caller with no fresh generation
 * is indistinguishable from one carrying a stale one, and accepting that
 * silently is the exact defect this closes.
 *
 * Exported so unit tests can exercise the cursor cases without driving the full
 * HTTP handler:
 *   1. Forward advance: bounded height > stored -> UPDATE fires -> returns it.
 *   2. Forward-only no-op: bounded <= stored -> UPDATE is a no-op -> returns stored.
 *   3. Concurrent no-op: concurrent caller already advanced past the bounded
 *      height -> UPDATE is a no-op -> fresh re-read returns the concurrent max.
 *   4. Ceiling: a caller posting a height above what it scanned contiguously
 *      moves the cursor only to the contiguous height.
 *
 * The forward-only guarantee is enforced by the UPDATE's conditional .or() filter:
 * the write fires only when the stored value is NULL or strictly less than the
 * bounded height. No application-level read-then-compare is involved; the
 * atomicity lives in the UPDATE predicate itself, so two concurrent callers
 * cannot both advance the cursor to their own (potentially lower) values.
 */

import { boundCursorAdvance } from '../_shared/scan-cursor.ts';

// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

export type AdvanceCursorResult =
  | {
    /** The stored cursor after this call, which may exceed boundedHeight when a concurrent caller went further. */
    effectiveCursor: number;
    /**
     * The height this call was willing to claim: the posted height capped by
     * the caller's contiguous height. The handler records its scan range
     * against THIS value, never the raw posted one, so the range can never
     * claim ground the cursor was not allowed to take.
     */
    boundedHeight: number;
  }
  | { error: string; status: number };

export function isAdvanceCursorError(
  r: AdvanceCursorResult,
): r is { error: string; status: number } {
  return 'error' in r;
}

export async function advanceCursor(
  client: SupabaseClient,
  platformId: string,
  connectionId: string,
  incomingHeight: number,
  clientContiguousScanned?: unknown,
): Promise<AdvanceCursorResult> {
  // OR-T1914: cap the advance at the last height the caller read contiguously.
  // A caller that supplies nothing usable gets incomingHeight unchanged, which
  // is the behaviour every existing caller already has.
  const boundedHeight = boundCursorAdvance(incomingHeight, clientContiguousScanned);

  const { data: updatedRow, error: updErr } = await client
    .from('stealth_connections')
    .update({
      last_block_scanned: boundedHeight,
      last_sync_at: new Date().toISOString(),
    })
    .eq('platform_id', platformId)
    .eq('id', connectionId)
    .or(`last_block_scanned.lt.${boundedHeight},last_block_scanned.is.null`)
    .select('last_block_scanned')
    .maybeSingle();

  if (updErr) {
    console.error('[advanceCursor] update failed:', updErr);
    return { error: 'Failed to update cursor', status: 500 };
  }

  if (updatedRow !== null) {
    return { effectiveCursor: boundedHeight, boundedHeight };
  }

  // No-op path: the stored cursor was already >= boundedHeight.
  // Re-read the row so the response reflects the actual stored cursor, not the
  // pre-UPDATE snapshot. A concurrent caller may have advanced the cursor further
  // between the ownership SELECT (in the handler) and this UPDATE; the fresh
  // read captures that maximum.
  //
  // NULL is impossible here: the UPDATE filter includes last_block_scanned.is.null,
  // so a null cursor always triggers the UPDATE and lands in the branch above.
  const { data: freshRow, error: freshErr } = await client
    .from('stealth_connections')
    .select('last_block_scanned')
    .eq('platform_id', platformId)
    .eq('id', connectionId)
    .maybeSingle();

  if (freshErr || !freshRow) {
    console.error('[advanceCursor] post-update read failed:', freshErr);
    return { error: 'Failed to read cursor after update', status: 500 };
  }

  // The UPDATE filter includes last_block_scanned.is.null, so null here means
  // the forward-only invariant has been violated: a null cursor should have
  // triggered the UPDATE and been handled in the branch above. Returning 0
  // silently would hide the bug; raise instead so it surfaces in logs.
  const storedCursor = freshRow.last_block_scanned as number | null;
  if (storedCursor === null) {
    console.error('[advanceCursor] invariant violated: cursor is null on no-op re-read path');
    return { error: 'Cursor invariant violated', status: 500 };
  }
  return { effectiveCursor: storedCursor, boundedHeight };
}
