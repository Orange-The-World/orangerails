/**
 * Frankfurter source plug-in — ECB fiat cross-rate provider.
 *
 * UNLIKE the BTC sources, Frankfurter does NOT participate in the
 * volume-weighted-median calculation. It is a CROSS-RATE provider used for
 * Tier C composite rates: `BTC↔X = BTC↔USD ORBI × USD↔X Frankfurter`.
 *
 * Endpoint: GET https://api.frankfurter.app/{date}?from=USD&to=MXN,EUR,GBP,...
 *   - date can be YYYY-MM-DD or "latest"
 *   - returns daily rates sourced from ECB
 *
 * Response shape:
 *   {
 *     "amount": 1,
 *     "base": "USD",
 *     "date": "2026-05-26",
 *     "rates": { "MXN": 17.32, "EUR": 0.93, ... }
 *   }
 *
 * Frankfurter is daily-granularity only. For ORBI-M minute rates that need
 * a fiat cross, we use the most recent business-day ECB rate. Fiat moves
 * orders of magnitude slower than BTC; daily granularity is sufficient.
 *
 * Per-source posture:
 *   - free community service, no API key required
 *   - rate-limited only by politeness (~1 rps is plenty)
 *   - ECB-sourced data; authoritative for EUR-base fiat per IAS 21
 *   - covers ~30 fiat currencies daily back to 1999-01-04
 */

import { BaseSource, type BaseSourceConfig } from "./base.ts";
import type { Candle, HealthStatus, Pair } from "./types.ts";

/**
 * Currencies Frankfurter publishes (verified via /currencies endpoint).
 * Subset listed here; full list available from api.frankfurter.app/currencies.
 */
const FIAT_PAIRS_SUPPORTED = [
  "USD-EUR", "USD-GBP", "USD-CAD", "USD-AUD", "USD-JPY", "USD-CHF",
  "USD-MXN", "USD-BRL", "USD-ARS", "USD-INR", "USD-TRY", "USD-ZAR",
  "USD-SGD", "USD-HKD", "USD-SEK", "USD-NOK", "USD-DKK", "USD-NZD",
  "USD-PLN", "USD-CZK", "USD-HUF", "USD-ILS", "USD-PHP", "USD-IDR",
  "USD-MYR", "USD-THB", "USD-KRW", "USD-CNY", "USD-TWD", "USD-RON",
  "USD-BGN", "USD-ISK",
  // Reverse pairs (Frankfurter can do these via from/to params)
  "EUR-USD", "GBP-USD", "CAD-USD", "JPY-USD",
];

export class FrankfurterSource extends BaseSource {
  constructor() {
    const cfg: BaseSourceConfig = {
      name: "frankfurter",
      // role: 'cross-rate' means: not a voting member of any BTC VW-median.
      // Used only for fiat cross-rate composites (Tier C).
      role: "cross-rate",
      endpointBase: "https://api.frankfurter.app",
      userAgent: "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)",
      rateLimitRps: 1.0,
      pairsSupported: FIAT_PAIRS_SUPPORTED,
    };
    super(cfg);
  }

  protected async fetchCandles(pair: Pair, _from: Date, to: Date): Promise<Candle[]> {
    const ourPair = `${pair.source}-${pair.target}`;
    if (!FIAT_PAIRS_SUPPORTED.includes(ourPair)) {
      throw new Error(`Frankfurter: unsupported pair ${ourPair}`);
    }

    // ECB rates are daily; use the date of the `to` timestamp
    const date = formatDate(to);
    const url = `${this.endpointBase}/${date}?from=${pair.source}&to=${pair.target}`;
    const res = await this.httpGet(url);
    const body = (await res.json()) as FrankfurterResponse;

    const rate = body.rates?.[pair.target];
    if (typeof rate !== "number" || !isFinite(rate) || rate <= 0) {
      throw new Error(`Frankfurter: no rate for ${pair.target} on ${date}`);
    }

    // Return one synthetic candle representing the day's ECB rate.
    // Volume = 1.0 normalized; ECB rates have no exchange volume concept.
    const dayStart = new Date(date + "T00:00:00Z");
    return [{
      bucketTs: dayStart,
      open: rate,
      high: rate,
      low: rate,
      close: rate,
      volume: 1.0,
    }];
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.waitForCadence();
      const url = `${this.endpointBase}/latest?from=USD&to=EUR`;
      const res = await this.httpGet(url);
      const body = (await res.json()) as FrankfurterResponse;
      const reachable = typeof body.rates?.EUR === "number" && body.rates.EUR > 0;
      return {
        name: this.name,
        reachable,
        lastSuccessAt: reachable ? new Date() : undefined,
        lastFailureAt: reachable ? undefined : new Date(),
        lastError: reachable ? undefined : "latest USD-EUR rate missing",
      };
    } catch (err) {
      return {
        name: this.name,
        reachable: false,
        lastFailureAt: new Date(),
        lastError: this.formatError(err),
      };
    }
  }
}

function formatDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

interface FrankfurterResponse {
  amount?: number;
  base?: string;
  date?: string;
  rates?: Record<string, number>;
}
