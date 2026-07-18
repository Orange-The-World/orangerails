/**
 * Orange Rails - Lightning Network confirms client types.
 *
 * Shared type surface for the Alby/Zeus/Breez confirms path.
 * These types live here so every provider adapter emits the same shape
 * into the ingest pipeline.
 */

/**
 * Terminal settled state for a Lightning invoice or payment.
 *
 * Contract:
 *   settled:true  + settled_at:"<ISO-8601>"  -> confirmed received/sent
 *   settled:false + settled_at:null          -> pending OR failed (both)
 *
 * Pending vs failed is tracked inside the client (for retry decisions).
 * The ingest pipeline only touches rows where settled:true, so the
 * distinction does not need to cross the ingest boundary.
 */
export type LNSettledState = {
  settled: boolean;
  settled_at: string | null;
};

/** Provider identifier used to select the right adapter at runtime. */
export type LNProviderName = 'alby' | 'zeus' | 'breez';

/**
 * One Lightning invoice normalised to a provider-agnostic shape.
 * The `state` field carries the canonical LNSettledState.
 */
export type LNInvoice = {
  /** Unique payment hash (hex). */
  payment_hash: string;
  /** Value of the invoice in millisatoshis. */
  amount_msat: number;
  /** Human-readable description / memo, or null if none. */
  description: string | null;
  /** ISO-8601 timestamp the invoice was created. */
  created_at: string;
  /** ISO-8601 timestamp the invoice expires, or null if unknown. */
  expires_at: string | null;
  /** Which provider emitted this record. */
  provider: LNProviderName;
  /** Terminal settled state. */
  state: LNSettledState;
};

/** Options passed to any provider fetch call. */
export type LNFetchOptions = {
  /**
   * Fetch only invoices settled after this ISO-8601 timestamp.
   * Providers that support server-side filtering pass it as a query param;
   * others filter client-side.
   */
  after?: string;
  /**
   * Maximum number of records to return per page.
   * Defaults to the provider maximum when omitted.
   */
  limit?: number;
  /**
   * Hard cap on the number of pages the adapter will fetch before throwing.
   *
   * Protects against a backend that ignores the page parameter and returns
   * the same full page on every request, which would spin the pagination
   * loop without bound. When the cap is reached the adapter throws so the
   * caller can decide whether to retry with a narrower window or alert.
   *
   * Omit to paginate until the provider signals exhaustion (a page shorter
   * than the page size).
   */
  maxPages?: number;
};
