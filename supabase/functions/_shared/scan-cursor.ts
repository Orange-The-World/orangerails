/**
 * scan-cursor.ts -- the ONE definition of what stealth_connections.last_block_scanned
 * means, and of the ceiling that protects it. OR-T1914.
 *
 * THE CONTRACT, in one sentence: on every endpoint that writes this column, the
 * wire field `last_block_scanned` is the last height the CALLER SCANNED
 * CONTIGUOUSLY. It is not a chain tip, and it is not the height of the highest
 * transaction the caller happens to have matched.
 *
 * WHY IT MUST BE THAT, and not a tip. The column is a resume point: the next
 * sync starts above it. A rolling-window extension pass can match a transaction
 * ABOVE the height where a filter fetch aborted, so "the highest thing I saw"
 * and "the highest point I actually read to" are different numbers. Store the
 * first and the next sync resumes above a range nobody ever read. A payment
 * inside that range is then missing from the customer's balance permanently:
 * no error, no flag, no retry path. That is the loss OR-T1120 was written to
 * stop, and it is silent, which is what makes it expensive.
 *
 * WHY IT LIVES HERE and not in either function. Two endpoints write this one
 * column, or-stealth-transactions-store and or-stealth-envelope-update, and
 * before OR-T1914 they documented it in opposite directions: one enforced the
 * ceiling, the other's header called the same field the scan tip. A reader of
 * either function had no way to tell whether the ceiling was a property of the
 * COLUMN or of one code path. It is a property of the column. Both functions
 * import these helpers, so the rule cannot drift into two versions again.
 *
 * WHAT THE SERVER CAN AND CANNOT CHECK, stated plainly so nobody mistakes this
 * for more protection than it is. The server holds no independent record of
 * what a caller read, so it cannot detect a caller that simply reports a tip in
 * this field. What it CAN do, and does, is refuse to let a second number raise
 * the cursor:
 *
 *   or-stealth-transactions-store derives the advance from data it holds (the
 *   block heights of rows it actually committed) and uses the caller's value
 *   only as a ceiling on that.
 *
 *   or-stealth-envelope-update has no server-side evidence to derive from, so
 *   the caller's value is the cursor. A caller that can distinguish its tip
 *   from its contiguous height sends contiguous_block_scanned as well and gets
 *   the same ceiling applied.
 *
 * In both cases the caller's number can only hold the cursor BACK, never push
 * it forward past stored state (DL-0419). A caller that lies loses ground; it
 * does not skip any.
 */

/**
 * The name of the contract above, so a comment or a test can cite it as a value
 * rather than restating the rule and drifting from it.
 */
export const SCAN_CURSOR_CONTRACT = 'last-contiguously-scanned-height' as const;

/**
 * True when the caller supplied a usable "last height I actually scanned
 * contiguously" value. Anything else (absent, non-integer, negative, wrong
 * type) counts as not supplied.
 *
 * REACHABILITY, written down so nobody has to work it out again: on
 * or-stealth-transactions-store the request validation already answers 400 when
 * last_block_scanned is absent, non-integer or negative, so on that live path
 * this predicate is always true. It is kept because boundCursorAdvance is a
 * pure function that must be safe for any caller, and because a bound that
 * silently depends on a validation three hundred lines away is the coupling
 * that rots first. It is NOT a backward-compatibility path there: no client can
 * reach that endpoint without sending the field. On or-stealth-envelope-update
 * the ceiling argument IS optional, and this predicate is what makes an absent
 * one mean "no ceiling supplied" instead of a type error.
 */
export function isContiguousScannedHeight(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0;
}

/**
 * Bound a cursor advance by the last height the CLIENT scanned contiguously
 * (OR-T1120, generalised to both endpoints by OR-T1914).
 *
 * candidateHeight is whatever the endpoint would otherwise write: the height of
 * a transaction that actually landed (transactions-store), or the value the
 * caller posted (envelope-update). Either way it is not, on its own, evidence
 * that every height below it was read.
 *
 * The client value is used ONLY as a ceiling, never to raise the cursor. That
 * keeps the DL-0419 property intact: a client that lies still cannot move the
 * watermark forward, it can only hold it back. A caller supplying no usable
 * value gets the unbounded candidate.
 *
 * In every correct sync the candidate is already at or below the contiguous
 * height, so this is a no-op. It only bites on the defect path.
 */
export function boundCursorAdvance(
  candidateHeight: number,
  clientContiguousScanned: unknown,
): number {
  if (!isContiguousScannedHeight(clientContiguousScanned)) return candidateHeight;
  return Math.min(candidateHeight, clientContiguousScanned);
}
