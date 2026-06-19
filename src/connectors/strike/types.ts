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

/** A typed Strike CSV row after delimiter + header parsing. */
export type StrikeCsvRow = {
  /** Raw date string from Strike, e.g. "Sep 24 2024 13:21:51". */
  date: string;
  /** "Receive" or "Send" (Strike's literal labels). */
  direction: "Receive" | "Send";
  /** Currency code, e.g. "BTC", "USD". */
  currency: string;
  /** Raw signed-amount string from Strike. May start with '-'. */
  amount: string;
  description: string;
  /** LN invoice or on-chain address. NOT a human contact. */
  destination: string;
  /** Optional network/routing fee in same currency. May be "0" or missing. */
  fee?: string;
  reference?: string;
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
