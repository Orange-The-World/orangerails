/**
 * Orange Rails - Lightning Network confirms client (shared interface).
 *
 * Every LN wallet adapter (Alby, Zeus, Breez) implements LNConfirmsClient.
 * The ingest pipeline calls fetchSettled() and only processes rows where
 * state.settled === true, leaving retry/pending logic to the adapter.
 */

import type { LNFetchOptions, LNInvoice, LNSettledState } from './types';

export type { LNFetchOptions, LNInvoice, LNSettledState };

/**
 * Normalise a raw provider timestamp (Unix seconds or ISO string)
 * to a nullable ISO-8601 string.
 *
 * Returns null when the value is absent or zero (epoch), which maps
 * the unsettled case to settled_at:null as the contract requires.
 */
export function toIsoSettledAt(raw: number | string | null | undefined): string | null {
  if (raw == null) return null;
  if (typeof raw === 'number') {
    if (raw <= 0) return null;
    return new Date(raw * 1000).toISOString();
  }
  if (typeof raw === 'string' && raw.length > 0) {
    return raw;
  }
  return null;
}

/**
 * Build a canonical LNSettledState from raw provider fields.
 *
 * Both pending and failed map to { settled: false, settled_at: null }.
 * Only a provider-confirmed settlement yields settled:true.
 */
export function toLNSettledState(
  settled: boolean,
  settledAt: number | string | null | undefined,
): LNSettledState {
  if (!settled) {
    return { settled: false, settled_at: null };
  }
  return { settled: true, settled_at: toIsoSettledAt(settledAt) };
}

/**
 * Shared interface every LN confirms adapter must implement.
 * fetchSettled returns only settled invoices (state.settled === true).
 */
export interface LNConfirmsClient {
  readonly provider: string;
  /**
   * Fetch settled invoices from the remote wallet/service.
   * Every returned item has state.settled === true.
   */
  fetchSettled(opts?: LNFetchOptions): Promise<LNInvoice[]>;
}
