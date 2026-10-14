/**
 * Orange Rails , Strike connector type surface.
 *
 * Strike is the first connector to handle a customer-trigger ingest where the
 * raw CSV is full of provider-specific quirks (semicolon delimiter, "Sep 24
 * 2024" dates, Receive/Send labels, no Account column, "Destination" =
 * LN-invoice/BTC-address). All of those quirks live in this folder so OR core
 * and V3 only ever see the canonical StagedImportPayload.
 */

import type { StagedImportPayload } from "../contract";

/**
 * Strike's literal "Transaction Type" values.
 *
 * Verified against a real "Annual transactions" export, which contained
 * Receive, Send, Sale, Purchase and Withdrawal. Deposit is documented by
 * Strike and is included for completeness. The connector previously modelled
 * only Receive and Send, and skipped every other row.
 */
export type StrikeTxType =
  | "Receive"
  | "Send"
  | "Deposit"
  | "Withdrawal"
  | "Purchase"
  | "Sale";

/** A typed Strike CSV row after delimiter + header parsing. */
export type StrikeCsvRow = {
  /** Raw date string from Strike, e.g. "Sep 24 2024 13:21:51". */
  date: string;
  /** Strike's literal Transaction Type label. */
  direction: StrikeTxType;
  /**
   * Currency code of the primary leg, e.g. "BTC", "EUR". Derived from the
   * header, because a real export has NO Currency column: it names the
   * currency inside the column itself ("Amount EUR").
   */
  currency: string;
  /** Raw signed-amount string for the primary leg. May start with '-'. */
  amount: string;
  description: string;
  /** LN invoice or on-chain address. NOT a human contact. */
  destination: string;
  /** Optional network/routing fee for the primary leg. May be "0" or missing. */
  fee?: string;
  reference?: string;

  /**
   * Both legs, kept separately because Purchase and Sale rows carry a fiat
   * amount AND a bitcoin amount on the same line. `amount` above is whichever
   * leg is primary (bitcoin when present) and exists so older callers keep
   * working unchanged.
   */
  btcAmount?: string;
  btcFee?: string;
  fiatAmount?: string;
  fiatFee?: string;
  /** Currency of the fiat leg, from the header. Varies per account. */
  fiatCurrency?: string;
  /** Fiat price of one bitcoin at the time. Only on Purchase / Sale. */
  btcPrice?: string;
  /** Strike's reported cost basis, in the fiat currency. Only on Purchase. */
  costBasis?: string;
  /** On-chain or Lightning hash. Absent on internal Strike transfers. */
  txHash?: string;
  /** The customer's own note, distinct from Strike's Description. */
  note?: string;
};

/** Best-effort shape of a Strike API account record. Fields TBD against docs. */
export type StrikeApiAccount = {
  id: string;
  currency: string;
  balance?: string;
};

/** Best-effort shape of a Strike API transaction record. Fields TBD against docs. */
export type StrikeApiTransaction = {
  id: string;
  occurredAt: string;
  direction: "Receive" | "Send";
  currency: string;
  amount: string;
  description?: string;
  destination?: string;
  fee?: string;
  reference?: string;
  /** Opaque Strike account identifier for the invoice recipient. */
  receiverId?: string;
};

/**
 * Both csv and api adapters implement this. The chooser (`index.ts`) depends
 * on this interface, not on concrete adapters , adding ShakePay/Blink later
 * means dropping in a sibling folder with two adapters of the same shape.
 */
export interface StrikeAdapter {
  ingest(): Promise<{
    payload: StagedImportPayload;
    warnings: string[];
    rows: StrikeCsvRow[];
  }>;
}

export class StrikeApiUnavailableError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StrikeApiUnavailableError";
  }
}
