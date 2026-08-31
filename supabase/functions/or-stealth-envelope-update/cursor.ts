/**
 * advanceCursor -- atomically advance last_block_scanned for a stealth connection.
 *
 * Exported so unit tests can exercise the three cursor cases without driving
 * the full HTTP handler:
 *   1. Forward advance: incoming tip > stored -> UPDATE fires -> returns incoming.
 *   2. Forward-only no-op: incoming <= stored -> UPDATE is a no-op -> returns stored.
 *   3. Concurrent no-op: concurrent caller already advanced past incoming ->
 *      UPDATE is a no-op -> fresh re-read returns the concurrent max.
 *
 * The forward-only guarantee is enforced by the UPDATE's conditional .or() filter:
 * the write fires only when the stored value is NULL or strictly less than
 * incomingTip. No application-level read-then-compare is involved; the atomicity
 * lives in the UPDATE predicate itself, so two concurrent callers cannot both
 * advance the cursor to their own (potentially lower) values.
 */

// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

export type AdvanceCursorResult =
  | { effectiveCursor: number }
  | { error: string; status: number };

export function isAdvanceCursorError(
  r: AdvanceCursorResult,
): r is { error: string; status: number } {
  return 'error' in r;
}

/**
 * OR-T1177: incomingTip is trusted, not verified, and that is a structural
 * fact about this function rather than an oversight.
 *
 * or-stealth-transactions-store bounds its cursor advance because it can:
 * it only advances when new rows actually landed, and it checks the
 * client's claimed scan tip against the real block_height of one of those
 * rows (boundCursorAdvance, that module). This function is the one that
 * must ALSO advance the cursor when a sync found zero new transactions --
 * that is its entire reason to exist (see the header comment in index.ts).
 * On that path nothing was inserted, so there is no server-established
 * height to check incomingTip against. A check built from data this
 * function has access to would only be comparing the client's number to
 * itself, which is not a bound.
 *
 * The forward-only guarantee below is real and holds regardless: a lying
 * client can never move the cursor backward, and can never move it past
 * what the STORED cursor already was without this specific incomingTip
 * value being accepted at face value once. The residual risk is that a
 * single call with an inflated incomingTip is trusted outright. Today that
 * risk is closed only by convention: sync.tsx sends the identical value to
 * or-stealth-transactions-store and to this function (result.lastBlockScanned
 * in both places), so an inflated claim would already have to have passed
 * whatever bound the store applied in the same round, on syncs that found
 * transactions. On a zero-transaction sync there is no such cross-check
 * anywhere in the system. Closing that for real needs a source of truth
 * this function does not have today (an independent chain-height reference);
 * see OR-T1177 for the open decision on whether to build one.
 */
export async function advanceCursor(
  client: SupabaseClient,
  platformId: string,
  connectionId: string,
  incomingTip: number,
): Promise<AdvanceCursorResult> {
  const { data: updatedRow, error: updErr } = await client
    .from('stealth_connections')
    .update({
      last_block_scanned: incomingTip,
      last_sync_at: new Date().toISOString(),
    })
    .eq('platform_id', platformId)
    .eq('id', connectionId)
    .or(`last_block_scanned.lt.${incomingTip},last_block_scanned.is.null`)
    .select('last_block_scanned')
    .maybeSingle();

  if (updErr) {
    console.error('[advanceCursor] update failed:', updErr);
    return { error: 'Failed to update cursor', status: 500 };
  }

  if (updatedRow !== null) {
    return { effectiveCursor: incomingTip };
  }

  // No-op path: the stored cursor was already >= incomingTip.
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
  return { effectiveCursor: storedCursor };
}
