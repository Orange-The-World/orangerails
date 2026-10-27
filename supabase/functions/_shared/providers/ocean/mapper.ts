/**
 * OCEAN mining pool: earnpay response -> NormalizedTransaction[].
 *
 * Pure mapping only. No fetch, no DB call, no credential handling -- OCEAN
 * needs none of those (see the file-level rationale in the commit that added
 * this file, and docs/Consumer-Integration-Guide.md, "Mining pool events:
 * earnings and payouts" / "Privacy"). Whatever calls OCEAN's public
 * `GET /v1/earnpay/<payout-address>` -- today that must be browser code, per
 * the CTO ruling on DL-1306 -- hands the parsed JSON body to
 * `mapOceanEarnpayResponse` and gets back rows shaped to the DL-1896
 * contract.
 */

import type { NormalizedTransaction } from '../types.ts';

export const OCEAN_SOURCE_TAG = 'ocean.api.v1';

/** One row of OCEAN's `earnings` array. Field names are OCEAN's own. */
export interface OceanEarningRow {
  block_hash: string;
  /** ISO-ish timestamp string, no timezone suffix, e.g. "2026-09-03T15:24:24". */
  ts: string;
  shares_in_window: number;
  /**
   * Verified live 2026-09-03: OCEAN's own field name has one L
   * ("colected"), not "collected". Do not "fix" this to match the ticket
   * brief's spelling -- that would silently stop mapping the real field.
   */
  fees_colected_satoshis: number;
  satoshis_net_earned: number;
}

/** One row of OCEAN's `payouts` array. */
export interface OceanPayoutRow {
  ts: string;
  on_chain_txid: string;
  total_satoshis_net_paid: number;
  is_generation_txn: boolean;
}

export interface OceanEarnpayResponse {
  result: {
    start_ts: string;
    end_ts: string;
    earnings: OceanEarningRow[];
    payouts: OceanPayoutRow[];
  };
}

/**
 * OCEAN's `ts` strings have no timezone suffix and are UTC. Date.parse
 * without a suffix is implementation-defined in general JS, but V8 (Deno,
 * every browser we ship to) treats a bare "YYYY-MM-DDTHH:mm:ss" as UTC, so
 * appending "Z" only makes that explicit rather than changing the value.
 */
function toIso(oceanTs: string): string {
  const withZone = oceanTs.endsWith('Z') ? oceanTs : `${oceanTs}Z`;
  const ms = Date.parse(withZone);
  if (Number.isNaN(ms)) {
    throw new Error(`[ocean] unparseable timestamp: ${JSON.stringify(oceanTs)}`);
  }
  return new Date(ms).toISOString();
}

/**
 * Map one OCEAN earnpay response to the two DL-1896 event types.
 *
 * @param response    Parsed JSON body from `GET /v1/earnpay/<payoutAddress>`.
 * @param payoutAddress The address the call was made for. OCEAN keys
 *                    entirely on this; it is also the connection's
 *                    `counterparty` since a miner never pays a pool.
 * @param sourceWalletId The `external_wallet_id` this connection resolved
 *                    to. Required on every row per the provider contract
 *                    (adapters MUST emit `source_wallet_id`); pass `null`
 *                    only for a legacy account-wide sync path, if OCEAN
 *                    ever grows one.
 */
export function mapOceanEarnpayResponse(
  response: OceanEarnpayResponse,
  payoutAddress: string,
  sourceWalletId: string | null,
): NormalizedTransaction[] {
  const earnings: NormalizedTransaction[] = response.result.earnings.map((row) => ({
    id: `ocean:earning:${row.block_hash}`,
    adapter: 'ocean',
    direction: 'in',
    type: 'mining_earning',
    amount_sats: row.satoshis_net_earned,
    currency: 'BTC',
    counterparty: payoutAddress,
    timestamp: toIso(row.ts),
    source_wallet_id: sourceWalletId,
    source_tag: OCEAN_SOURCE_TAG,
  }));

  const payouts: NormalizedTransaction[] = response.result.payouts.map((row) => ({
    id: `ocean:payout:${row.on_chain_txid}`,
    adapter: 'ocean',
    direction: 'in',
    type: 'mining_payout',
    amount_sats: row.total_satoshis_net_paid,
    currency: 'BTC',
    counterparty: payoutAddress,
    timestamp: toIso(row.ts),
    source_wallet_id: sourceWalletId,
    txid: row.on_chain_txid,
    // vout intentionally omitted: see the KNOWN GAP note in this file's
    // introducing commit. OCEAN's earnpay response carries no output index.
    from_coinbase: row.is_generation_txn,
    source_tag: OCEAN_SOURCE_TAG,
  }));

  return [...earnings, ...payouts];
}
