/**
 * Pure helpers for or-quiltt-drain-alert.
 *
 * These live apart from index.ts because index.ts calls Deno.serve as soon as
 * it is imported, so a test cannot import it. Nothing in this file reads the
 * environment, the clock or the network.
 */

/**
 * Observable signal state at the time of a Zulip post. Stored in
 * drain_alert_state.last_signal_snapshot (a jsonb column) and compared on the
 * next run to decide whether posting again would tell the reader anything new.
 */
export interface SignalSnapshot {
  failure_rate_firing:      boolean;
  failure_rate:             number | null;
  zero_completions_firing:  boolean;
  succeeded_count:          number | null;
  stall_firing:             boolean;
  stalled:                  number | null;
  retired_firing:           boolean;
  retired:                  number | null;
  query_error:              string | null;
  starvation_firing:        boolean;
  unprocessed_non_deferred: number | null;
}

/**
 * Canonical form of a snapshot, used only for comparison.
 *
 * Two things made the raw comparison unreliable:
 *  1. The stored copy comes back from a jsonb column, and Postgres returns
 *     jsonb keys shorter-first then alphabetical, not in insertion order.
 *     JSON.stringify follows insertion order, so the stored copy and a freshly
 *     built one never serialized to the same text.
 *  2. Counters that belong to a signal that is not firing changed the text
 *     with nothing a reader could act on. succeeded_count is the worst case:
 *     it slides every minute inside a 60 minute window.
 *
 * The canonical form fixes the key order, and keeps a counter only while the
 * signal that owns it is firing.
 */
export function normalizeSnapshot(s: SignalSnapshot): SignalSnapshot {
  return {
    failure_rate_firing:      s.failure_rate_firing,
    failure_rate:             s.failure_rate_firing ? s.failure_rate : null,
    zero_completions_firing:  s.zero_completions_firing,
    succeeded_count:          s.zero_completions_firing ? s.succeeded_count : null,
    stall_firing:             s.stall_firing,
    stalled:                  s.stall_firing ? s.stalled : null,
    retired_firing:           s.retired_firing,
    retired:                  s.retired_firing ? s.retired : null,
    query_error:              s.query_error,
    starvation_firing:        s.starvation_firing,
    unprocessed_non_deferred: s.starvation_firing ? s.unprocessed_non_deferred : null,
  };
}

/** True when two snapshots represent the same observable signal state. */
export function snapshotsMatch(a: SignalSnapshot | null, b: SignalSnapshot): boolean {
  if (a === null) return false;
  return JSON.stringify(normalizeSnapshot(a)) === JSON.stringify(normalizeSnapshot(b));
}

/**
 * Short name of the Supabase project this function is running in: the first
 * label of the host name in SUPABASE_URL. The dev and prod copies of this
 * function post into the same Zulip topic, and an alert did not say which one
 * it came from. Never throws.
 */
export function projectLabel(url: string | null | undefined): string {
  if (!url) return 'unknown project';
  try {
    return new URL(url).hostname.split('.')[0] || 'unknown project';
  } catch {
    return 'unknown project';
  }
}
