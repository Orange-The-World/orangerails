/**
 * The Source plug-in interface.
 *
 * Every data source ORBI consumes (Kraken, Bitstamp, Bitfinex, mempool.space,
 * Bitso, Mercado Bitcoin, future paid sources via Kaiko / CoinDesk Data) implements
 * this interface. Activation is config-driven via the exchange_rate_providers
 * table; the calculation engine reads only the active sources at request time.
 *
 * Adding, removing, disabling, or replacing a source is a CONFIG flag change,
 * never a code change in the calculation engine. This is the engineering bedrock
 * of ORBI's Hybrid Asymmetric Risk-Management Strategy.
 *
 * See https://wiki.abascal.ca/doc/orbi-hybrid-asymmetric-risk-management-strategy-2AVKLwrxlF
 */

import type { HealthStatus, Pair, SourceResponse } from "./types";

export interface Source {
  /** Unique identifier; matches exchange_rate_providers.name. */
  readonly name: string;

  /**
   * Role in the calculation. Primary sources vote in the VW-median.
   * Secondary sources are logged in the audit row but not voting.
   * Cross-rate sources are used for composite calculations (Frankfurter).
   */
  readonly role: "primary" | "secondary" | "cross-check" | "cross-rate" | "inactive";

  /** Pairs this source quotes natively. Used for routing. */
  readonly pairsSupported: ReadonlyArray<string>;

  /** Polite-scraping ceiling for this source in requests-per-second. */
  readonly rateLimitRps: number;

  /** User-Agent header sent with every request. */
  readonly userAgent: string;

  /**
   * Fetch 1-minute OHLC candles for the given pair within the window.
   * Implementations must:
   *  - Honor rateLimitRps (sleep / queue as needed)
   *  - Use exponential backoff on 429/5xx, honoring Retry-After when present
   *  - Return SourceResponse with success=false on any failure (do not throw)
   *  - Tag fetchedAt with the response timestamp
   */
  fetch(pair: Pair, from: Date, to: Date): Promise<SourceResponse>;

  /**
   * Health check; called by or-rate-health Edge Function for the public
   * status dashboard. Should be cheap (single ticker / status endpoint call).
   */
  healthCheck(): Promise<HealthStatus>;
}

/**
 * Per-source operational rules that the base class enforces.
 * Plug-in implementations should not override these without reason.
 */
export const SOURCE_OPERATIONAL_RULES = {
  /** Per-request timeout in ms. */
  REQUEST_TIMEOUT_MS: 3000,
  /** Exponential backoff base. */
  BACKOFF_BASE_MS: 1000,
  /** Maximum backoff before giving up on a single fetch. */
  BACKOFF_MAX_MS: 60000,
  /** Standard accept headers. */
  ACCEPT_HEADERS: {
    Accept: "application/json",
    "Accept-Encoding": "gzip",
  },
} as const;
