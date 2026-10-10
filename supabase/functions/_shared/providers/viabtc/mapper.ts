/**
 * ViaBTC wallet-API rows -> NormalizedTransaction[].
 *
 * Two event types, per DL-1896 / docs/Consumer-Integration-Guide.md:
 *   payment history  -> mining_payout  (on-chain settlement, txid required)
 *   profit / reward  -> mining_earning (pool credit, no txid)
 *
 * vout is left undefined: Acquire Payment History does not return an output
 * index. Do not default it to 0.
 */

import type { NormalizedTransaction } from "../types.ts";
import { VIABTC_SOURCE_TAG, type ViaBtcPaymentRow, type ViaBtcProfitRow } from "./types.ts";

const SATS_PER_BTC = 100_000_000;

/**
 * Convert a decimal coin amount to satoshis using integer math.
 * Only for BTC. Throws rather than guessing on a malformed string.
 */
export function btcToSats(amount: string): number {
  const trimmed = amount.trim();
  if (!trimmed) {
    throw new Error(`[viabtc] unparseable amount: ${JSON.stringify(amount)}`);
  }
  const neg = trimmed.startsWith("-");
  const unsigned = neg ? trimmed.slice(1) : trimmed;
  const [wholeRaw, fracRaw = ""] = unsigned.split(".");
  const whole = wholeRaw === "" ? "0" : wholeRaw;
  if (!/^\d+$/.test(whole) || (fracRaw !== "" && !/^\d+$/.test(fracRaw))) {
    throw new Error(`[viabtc] unparseable amount: ${JSON.stringify(amount)}`);
  }
  const frac = (fracRaw + "00000000").slice(0, 8);
  const sats = Number(whole) * SATS_PER_BTC + Number(frac);
  return neg ? -sats : sats;
}

function isBtc(coin: string): boolean {
  return coin.toUpperCase() === "BTC";
}

function amountFields(coin: string, amount: string): Pick<NormalizedTransaction, "amount_sats" | "amount" | "currency"> {
  const currency = coin.toUpperCase();
  if (isBtc(currency)) {
    return { amount_sats: btcToSats(amount), currency };
  }
  const n = Number(amount);
  if (!Number.isFinite(n)) {
    throw new Error(`[viabtc] unparseable amount: ${JSON.stringify(amount)}`);
  }
  return { amount: n, currency };
}

function isZeroAmount(amount: string): boolean {
  const t = amount.trim();
  if (!t) return true;
  return /^0+(\.0+)?$/.test(t);
}

export function unixSecondsToIso(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`[viabtc] unparseable timestamp: ${JSON.stringify(seconds)}`);
  }
  return new Date(seconds * 1000).toISOString();
}

/** Treat a wiki `YYYY-MM-DD` as midnight UTC. */
export function profitDateToIso(date: string): string {
  const m = date.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    throw new Error(`[viabtc] unparseable date: ${JSON.stringify(date)}`);
  }
  return `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`;
}

export function mapPaymentRow(
  row: ViaBtcPaymentRow,
  sourceWalletId: string | null,
): NormalizedTransaction | null {
  if (isZeroAmount(row.amount)) return null;
  const amounts = amountFields(row.coin, row.amount);
  return {
    id: `viabtc:payout:${row.id}`,
    adapter: "viabtc",
    direction: "in",
    type: "mining_payout",
    ...amounts,
    counterparty: row.address,
    timestamp: unixSecondsToIso(row.create_time),
    source_wallet_id: sourceWalletId,
    txid: row.tx,
    // vout omitted: payment history has no output index.
    source_tag: VIABTC_SOURCE_TAG,
    description: `ViaBTC payout ${row.coin}`,
  };
}

export function mapProfitRow(
  row: ViaBtcProfitRow,
  sourceWalletId: string | null,
  kind: "profit" | "reward" = "profit",
): NormalizedTransaction | null {
  if (isZeroAmount(row.total_profit)) return null;
  const amounts = amountFields(row.coin, row.total_profit);
  return {
    id: `viabtc:${kind}:${row.coin.toUpperCase()}:${row.date}`,
    adapter: "viabtc",
    direction: "in",
    type: "mining_earning",
    ...amounts,
    timestamp: profitDateToIso(row.date),
    source_wallet_id: sourceWalletId,
    source_tag: VIABTC_SOURCE_TAG,
    description: `ViaBTC ${kind} ${row.coin} ${row.date}`,
  };
}

export function mapPayments(
  rows: ViaBtcPaymentRow[],
  sourceWalletId: string | null,
): NormalizedTransaction[] {
  const out: NormalizedTransaction[] = [];
  for (const row of rows) {
    const mapped = mapPaymentRow(row, sourceWalletId);
    if (mapped) out.push(mapped);
  }
  return out;
}

export function mapProfits(
  rows: ViaBtcProfitRow[],
  sourceWalletId: string | null,
  kind: "profit" | "reward" = "profit",
): NormalizedTransaction[] {
  const out: NormalizedTransaction[] = [];
  for (const row of rows) {
    const mapped = mapProfitRow(row, sourceWalletId, kind);
    if (mapped) out.push(mapped);
  }
  return out;
}
