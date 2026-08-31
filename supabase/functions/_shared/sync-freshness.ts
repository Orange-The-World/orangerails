/**
 * Sync freshness, computed at read time. DL-1737.
 *
 * THE PROBLEM. A connection that last synced 28 days ago and one that synced
 * an hour ago report the same thing on every read surface we have: `status`
 * is 'active' and `encrypted_last_error` is null on both. Nothing says which
 * is which, so the product cannot tell a customer the difference between
 * "nobody has asked us to sync" and "our sync is broken".
 *
 * WHY THIS IS COMPUTED AND NOT STORED. or-sync is not scheduled by us. It
 * runs when a consumer calls it. So when nobody calls, no code of ours runs,
 * and nothing can stamp a warning at the moment a connection goes stale. A
 * background job could do it, but then we own another timer that can itself
 * die silently, which is the same class of failure this signal exists to make
 * visible. Derived from `last_sync_at` and the current time inside the
 * response, it needs no scheduler and cannot go quietly dead.
 *
 * WHY A NEW FIELD RATHER THAN A NEW `status` VALUE. Consumers switch on
 * `status`. Adding a value to that vocabulary breaks every one of them that
 * has no branch for it. This is strictly additive: `status` is not read here
 * and not written here.
 *
 * WHY 72 HOURS. The sync trigger is a user or a consumer app, so a gap of a
 * day or two is normal and must not alarm anyone. The failure being made
 * visible measured 13 to 28 days. 72 hours sits far above the normal pattern
 * and far below the failure. The number ships in the payload as
 * `stale_after_hours` so no consumer hardcodes it and we can tune it without
 * a client release.
 *
 * WHAT THIS MEASURES, AND WHAT IT DOES NOT. It measures `last_sync_at`, and
 * nothing else. For the `connections` table that column is written in exactly
 * three places, all of them in or-sync. or-quiltt-sync persists customer
 * transactions on a per-minute drain and never writes it, so a Quiltt
 * connection can be fed continuously while this reports it stale. That is a
 * defect on the WRITE side, not here, and it is tracked separately: the fix
 * is to stamp `last_sync_at` when the drain persists rows, after which this
 * field means exactly what its name says on every provider.
 *
 * Do not paper over that here by deriving freshness from the newest
 * transaction we hold. A dormant account with a perfectly working sync has no
 * new transactions, so it would read stale too. Trading one wrong answer for
 * another is not a fix, and it would put the guess in the read path where it
 * is much harder to remove later.
 *
 * `stealth_connections` has no such gap: or-stealth-transactions-store and
 * or-stealth-envelope-update both stamp `last_sync_at` on every write, so the
 * signal is honest there today.
 */

/**
 * Hours of silence after which a connection is reported stale.
 *
 * One constant, imported by both list endpoints. A threshold copied into two
 * files is a threshold that drifts, and two read surfaces disagreeing about
 * whether the same connection is stale is worse than having no signal at all.
 */
export const STALE_AFTER_HOURS = 72;

const MS_PER_HOUR = 3_600_000;

/**
 * `never`  we hold no usable record of a sync for this connection.
 * `fresh`  last sync is within STALE_AFTER_HOURS.
 * `stale`  last sync is older than that.
 */
export type SyncFreshness = 'never' | 'fresh' | 'stale';

/** The three fields added to every row on both list endpoints. */
export interface SyncFreshnessFields {
  sync_freshness: SyncFreshness;
  /**
   * Hours since `last_sync_at`, to two decimal places, or null when there is
   * no usable stamp.
   *
   * Rounded to the same value the verdict is computed from, deliberately, so
   * a consumer that re-derives the verdict from this number can never
   * disagree with `sync_freshness` in the same payload.
   *
   * A negative value means the stored stamp is in the future, which is clock
   * skew. It is reported rather than clamped to zero: a clamped zero reads as
   * a sync that just happened, which is the exact false reassurance this
   * whole field exists to remove.
   */
  hours_since_sync: number | null;
  /** Always STALE_AFTER_HOURS. Present on every row, including 'never'. */
  stale_after_hours: number;
}

/**
 * Compute the freshness fields for one row.
 *
 * `now` is a required parameter rather than a `new Date()` inside, so one
 * response measures every row against one clock. With the clock read
 * per-row, two connections stamped at the same instant could land on
 * different sides of the threshold in the same payload.
 *
 * An unparseable stamp returns 'never', not 'fresh'. A path that recognised
 * nothing must never return the value that means all is well, and "we have no
 * usable record of a sync" is the literal truth about a corrupt timestamp.
 */
export function computeSyncFreshness(
  lastSyncAt: string | null | undefined,
  now: Date,
): SyncFreshnessFields {
  const noUsableStamp: SyncFreshnessFields = {
    sync_freshness: 'never',
    hours_since_sync: null,
    stale_after_hours: STALE_AFTER_HOURS,
  };

  if (typeof lastSyncAt !== 'string' || lastSyncAt.length === 0) return noUsableStamp;

  const stampedAt = Date.parse(lastSyncAt);
  if (Number.isNaN(stampedAt)) return noUsableStamp;

  const hoursSinceSync =
    Math.round(((now.getTime() - stampedAt) / MS_PER_HOUR) * 100) / 100;

  // A negative hoursSinceSync means the stored stamp is in the future. That
  // is not evidence of a real sync inside the freshness window, so it must
  // not return the value that means all is well, the same rule already
  // applied a few lines up to an unparseable stamp. hours_since_sync itself
  // is left exactly as computed, negative and all: only the verdict gets
  // the lower bound.
  const isFresh = hoursSinceSync >= 0 && hoursSinceSync <= STALE_AFTER_HOURS;

  return {
    sync_freshness: isFresh ? 'fresh' : 'stale',
    hours_since_sync: hoursSinceSync,
    stale_after_hours: STALE_AFTER_HOURS,
  };
}
