/**
 * Orange Rails, Coinbase connector type surface.
 *
 * Coinbase's "Transaction history" CSV report has its own quirks (a metadata
 * preamble before the header row, ISO-8601 UTC timestamps, a per-asset
 * "Quantity Transacted" column whose sign lives in the Transaction Type, and
 * a large vocabulary of transaction types: Buy / Sell / Send / Receive /
 * Convert / *Income / *Reward / ...). All of those quirks live in this folder
 * so OR core and V3 only ever see the canonical StagedImportPayload.
 *
 * Built to Coinbase's documented report layout. Header matching is
 * alias-based (see csv.ts HEADER_ALIASES) so minor column-name revisions or
 * the older/newer report variants still parse; validate against a fresh real
 * export before relying on a new transaction-type mapping.
 */

/** A typed Coinbase CSV row after preamble-skip + header parsing. */
export type CoinbaseCsvRow = {
  /** Raw ISO-8601 timestamp, e.g. "2024-09-24T13:21:51Z". */
  timestamp: string;
  /** Coinbase transaction type, e.g. "Buy", "Sell", "Send", "Receive". */
  type: string;
  /** Asset ticker, e.g. "BTC", "ETH", "USDC". */
  asset: string;
  /** Quantity of the asset transacted. Always positive; the type carries sign. */
  quantity: string;
  /** Fiat currency the spot price / totals are denominated in, e.g. "USD". */
  spotPriceCurrency?: string;
  /** Spot price of one unit of the asset at transaction time. */
  spotPrice?: string;
  /** Fiat subtotal before fees. */
  subtotal?: string;
  /** Fiat total inclusive of fees and/or spread. */
  total?: string;
  /** Fiat fees and/or spread. */
  fees?: string;
  /** Free-text notes (often the counterparty address or memo). */
  notes?: string;
  /** Optional stable transaction id (present in newer report variants). */
  id?: string;
  /**
   * 1-based line number this row occupied in the source file, for accurate
   * diagnostics. Coinbase skips a metadata preamble, so a row's position in
   * the parsed array is NOT its file line; warnings must report this instead.
   */
  sourceLine?: number;
};
