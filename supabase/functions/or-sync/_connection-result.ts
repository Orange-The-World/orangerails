/**
 * Pure shaping of one connection's entry in the or-sync response.
 *
 * Extracted rather than left inline because `or-sync/index.ts` calls
 * `Deno.serve` at module scope, so importing it from a test stands up a server.
 * That made this wiring reachable only by reading the file as text and
 * regex-matching it, which proves the lines exist and nothing about what they
 * do. Same move, and the same reason, as `_sparrow-init-handler.ts` (DL-0448).
 *
 * Nothing here touches the network, the database, or the clock.
 */

/** What an adapter reported about the completeness of one sync pass. */
export interface SyncCompleteness {
  /** True when the pass finished but is known to have missed history. */
  partial: boolean;
  /** Kinds of history the provider refused: 'trades' | 'deposits' | 'withdrawals'. */
  deniedSources: string[];
}

/** One element of the `connections` array in the or-sync response body. */
export interface ConnectionResult {
  connection_id: string;
  synced: number;
  next_cursor: string | null;
  partial?: boolean;
  denied_sources?: string[];
}

/** The subset of SyncResult this module reads. Deliberately structural. */
interface AdapterSyncOutcome {
  partial?: boolean;
  denied_sources?: string[];
}

/**
 * Normalize what an adapter said about completeness.
 *
 * Adapters predating these fields return neither, and a missing field means
 * "complete" rather than "unknown": every adapter that cannot under-report has
 * nothing to declare. Absent, null and undefined all collapse to a complete
 * sync with no denied sources, so a caller never has to null-check.
 */
export function readSyncCompleteness(
  out: AdapterSyncOutcome | null | undefined,
): SyncCompleteness {
  return {
    partial: out?.partial === true,
    deniedSources: Array.isArray(out?.denied_sources) ? out!.denied_sources! : [],
  };
}

/**
 * Build one connection's entry in the response.
 *
 * `partial` and `denied_sources` are ADDITIVE: they appear only when there is
 * something to report, so a healthy sync returns exactly the three fields it
 * always did and existing consumers are untouched. That is the property worth
 * pinning, because breaking it is silent -- a consumer parsing a shape it did
 * not expect fails at its end, not ours.
 *
 * A denied source always implies partial. An adapter that reports denied
 * sources without setting `partial` is corrected here rather than trusted,
 * since the alternative is writing status='active' over history nobody read.
 */
export function buildConnectionResult(
  connectionId: string,
  synced: number,
  nextCursor: string | null,
  completeness: SyncCompleteness,
): ConnectionResult {
  const denied = completeness.deniedSources.filter((s) => typeof s === 'string' && s.length > 0);
  const partial = completeness.partial || denied.length > 0;

  return {
    connection_id: connectionId,
    synced,
    next_cursor: nextCursor,
    ...(partial ? { partial: true } : {}),
    ...(denied.length > 0 ? { denied_sources: denied } : {}),
  };
}
