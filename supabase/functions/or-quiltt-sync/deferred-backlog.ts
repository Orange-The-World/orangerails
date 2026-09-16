/**
 * OPK deferred-row backlog: detect and alert, never purge (OR-T0267).
 *
 * quiltt_webhook_inbox rows get opk_deferred_at stamped when the owning
 * subaccount has no opk_public yet (see markDeferred in index.ts).
 * reDriveReadyDeferrals() clears that stamp once opk_public is set, but a
 * subaccount that NEVER registers an OPK never clears, so its deferred rows
 * accumulate for the life of the connection with nothing surfacing it.
 *
 * Scope, deliberately narrow per the ticket: MEASURE the backlog and ALERT
 * past a threshold. No retention, no purge, no delete or update of any
 * opk_deferred_at row anywhere in this file.
 */

// Structural stand-in for the supabase client, matching the pattern already
// used in vault-persist.ts: the generated database types do not cover every
// table, and naming the escape hatch once in a type is what lets a test pass
// a fake client in.
// deno-lint-ignore no-explicit-any
export type DeferredBacklogClient = { from: (table: string) => any };

export interface DeferredBacklogEntry {
  subaccount_id: string;
  deferred_count: number;
  oldest_deferred_at: string;
  age_days: number;
}

interface DeferredRow {
  subaccount_id: string;
  opk_deferred_at: string;
}

/** Rows fetched per page while measuring. Read-only; never the write path. */
const MEASURE_PAGE_SIZE = 1000;

/**
 * Fetch every currently-deferred row (opk_deferred_at IS NOT NULL) and group
 * by subaccount into a count and an oldest timestamp.
 *
 * Paged rather than a single unbounded select, for the same reason every
 * other read on this persistence path is paged (see vault-persist.ts): an
 * unpaged select that is capped server-side returns fewer rows than exist
 * with no error at all, which would UNDER-count the backlog. Undercounting a
 * measurement built specifically to catch silent accumulation would defeat
 * the point.
 */
export async function measureOpkDeferredBacklog(
  supabase: DeferredBacklogClient,
  now: Date = new Date(),
): Promise<DeferredBacklogEntry[]> {
  const rows: DeferredRow[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('quiltt_webhook_inbox')
      .select('subaccount_id, opk_deferred_at')
      .not('opk_deferred_at', 'is', null)
      .order('id', { ascending: true })
      .range(offset, offset + MEASURE_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as DeferredRow[];
    rows.push(...page);
    if (page.length < MEASURE_PAGE_SIZE) break;
    offset += MEASURE_PAGE_SIZE;
  }

  const bySubaccount = new Map<string, { count: number; oldest: string }>();
  for (const row of rows) {
    const existing = bySubaccount.get(row.subaccount_id);
    if (!existing) {
      bySubaccount.set(row.subaccount_id, { count: 1, oldest: row.opk_deferred_at });
      continue;
    }
    existing.count += 1;
    if (row.opk_deferred_at < existing.oldest) existing.oldest = row.opk_deferred_at;
  }

  const nowMs = now.getTime();
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Array.from(bySubaccount.entries()).map(([subaccount_id, { count, oldest }]) => ({
    subaccount_id,
    deferred_count: count,
    oldest_deferred_at: oldest,
    age_days: (nowMs - new Date(oldest).getTime()) / MS_PER_DAY,
  }));
}

export interface BacklogThreshold {
  maxAgeDays: number;
  maxCount: number;
}

/**
 * Default thresholds. Chosen against a live read of orange-rails-prod on
 * 2026-09-05 (see the PR/commit for OR-T0267): the one subaccount with a
 * backlog that day had 16 rows at 15.0 days old, so 14 days / 25 rows are
 * round numbers past what is currently seen in production, not untested
 * guesses, and that subaccount would already breach the age threshold today.
 */
export const DEFAULT_BACKLOG_THRESHOLD: BacklogThreshold = {
  maxAgeDays: 14,
  maxCount: 25,
};

/** Pure: which entries cross either threshold. Either condition alone is enough. */
export function findBacklogBreaches(
  entries: DeferredBacklogEntry[],
  threshold: BacklogThreshold,
): DeferredBacklogEntry[] {
  return entries.filter(
    (e) => e.age_days >= threshold.maxAgeDays || e.deferred_count >= threshold.maxCount,
  );
}

/**
 * Measure, find breaches, and alert on each one via `report`.
 *
 * Never deletes or updates a row: this is detect-and-report only, per the
 * ticket's explicit scope. `report` is injected rather than importing the
 * shared GlitchTip reporter directly, so this function stays testable with
 * no network calls; the production call site wires it to reportError from
 * ../_shared/sentry.ts so a breach is visible the same way any other
 * production error in this codebase is, with no new alert channel invented
 * for this one case.
 */
export async function checkOpkDeferredBacklogAndAlert(
  supabase: DeferredBacklogClient,
  threshold: BacklogThreshold,
  report: (err: Error) => void | Promise<void>,
  now: Date = new Date(),
): Promise<DeferredBacklogEntry[]> {
  const entries = await measureOpkDeferredBacklog(supabase, now);
  const breaches = findBacklogBreaches(entries, threshold);
  for (const breach of breaches) {
    await report(
      new Error(
        `opk-deferred-backlog: subaccount ${breach.subaccount_id} has ${breach.deferred_count} ` +
          `deferred row(s), oldest ${breach.age_days.toFixed(1)}d old ` +
          `(threshold ${threshold.maxCount} rows / ${threshold.maxAgeDays}d)`,
      ),
    );
  }
  return breaches;
}
