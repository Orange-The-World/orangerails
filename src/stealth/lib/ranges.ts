/**
 * Resume-height computation over the persistent scan coverage map.
 *
 * Background. Stealth sync used to remember a single number per connection,
 * `last_block_scanned`, and resume from one block after it. That cursor cannot
 * express "I scanned 800000 to 850000 but never touched 700000 to 799999", so
 * a wallet whose birthday is older than the first scan could never be filled
 * in: the cursor always sat ahead of the gap and the gap stayed invisible.
 * Migration 20260821000000 replaced it with a set of non-overlapping
 * [from_height, to_height] intervals per connection.
 *
 * This module is the read side of that migration. It was specified in the
 * migration header and then never written, so ranges were recorded on every
 * sync and consulted by nothing.
 *
 * The rule implemented here is the one the migration header states, verbatim:
 *
 *   Resume logic: to_height of the range that contains birthdayHeight (i.e.
 *     from_height <= birthdayHeight AND to_height >= birthdayHeight),
 *   else birthdayHeight itself. Computed at query time by the caller.
 *
 * "By the caller" is load-bearing and is why this is a browser-side pure
 * function rather than a server computation. The birthday height is derived
 * by resolving the wallet birthday out of the SEALED envelope against a block
 * source, in the user's browser. The server never learns it and should not
 * have to be told it in order to answer a resume query.
 *
 * Everything here is pure: no I/O, no clock, no network. The caller fetches
 * the ranges and passes them in.
 */

/** One recorded scan interval, inclusive at both ends. */
export interface ScanRange {
  from_height: number;
  to_height: number;
}

/**
 * True when `height` falls inside the inclusive interval.
 *
 * Both ends are inclusive because that is how `record_stealth_scan_range()`
 * writes them, and because a half-open reading here would silently drop the
 * boundary block from coverage.
 */
function contains(range: ScanRange, height: number): boolean {
  return range.from_height <= height && range.to_height >= height;
}

/**
 * Return the block height a sync should resume from.
 *
 * If some recorded range already covers the wallet birthday, the scan can
 * start at that range's `to_height`: everything from the birthday up to there
 * has been read. Otherwise there is no contiguous coverage anchored at the
 * birthday and the scan must start at the birthday itself, however far back
 * that is and regardless of any later ranges that may exist.
 *
 * That last clause is the whole point of the change. A connection can hold a
 * range far ahead of the birthday with nothing joining the two, and the honest
 * answer there is "start at the birthday", not "start at the highest number I
 * can see". The old cursor gave the second answer.
 *
 * Returning `to_height` rather than `to_height + 1` is deliberate and matches
 * the header. Consecutive ranges written by the widget already share their
 * boundary block, so re-reading one block on resume costs a single filter and
 * removes a whole class of off-by-one gap. Matching is idempotent, so a block
 * read twice cannot produce a duplicate transaction.
 *
 * Malformed rows are ignored rather than trusted: an interval whose end is
 * before its start, or which carries a non-finite bound, cannot describe real
 * coverage, and treating it as coverage would skip blocks that were never
 * read. The table has a CHECK constraint that should make this unreachable;
 * this is the belt to that CHECK's braces, because the cost of being wrong is
 * a permanently unscanned window that nothing ever revisits.
 */
export function resumeHeightFromRanges(
  ranges: readonly ScanRange[] | null | undefined,
  birthdayHeight: number,
): number {
  if (!Number.isFinite(birthdayHeight)) {
    throw new Error("stealth/ranges: birthdayHeight must be a finite number");
  }
  if (!ranges || ranges.length === 0) return birthdayHeight;

  let resume = birthdayHeight;
  for (const range of ranges) {
    if (
      !Number.isFinite(range.from_height) ||
      !Number.isFinite(range.to_height) ||
      range.to_height < range.from_height
    ) {
      continue;
    }
    if (contains(range, birthdayHeight) && range.to_height > resume) {
      resume = range.to_height;
    }
  }
  return resume;
}
