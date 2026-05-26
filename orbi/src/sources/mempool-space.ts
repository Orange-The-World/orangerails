/**
 * mempool.space source plug-in.
 *
 * Endpoints:
 *   - Current: GET https://mempool.space/api/v1/prices
 *   - Historical: GET https://mempool.space/api/v1/historical-price?currency=USD&timestamp=N
 *
 * Important caveats:
 *   - mempool.space historical returns DAILY data, not minute candles.
 *   - For minute granularity, the /prices endpoint gives current snapshot only.
 *   - This means mempool.space is most useful for:
 *     (a) ORBI-D daily fixing inputs
 *     (b) Recent-minute confirmation (use /prices to verify ORBI-M against)
 *     (c) Multi-fiat coverage where direct sources don't quote a pair
 *
 * For ORBI-M (per-minute), mempool's current /prices is sampled at the moment
 * we fetch, so we treat it as "best available at minute T" with high latency
 * tolerance. Volume is reported but represents an aggregate, not a single-
 * exchange volume, so it's normalized to a constant 1.0 placeholder for the
 * VW-median (mempool's price becomes one equally-weighted vote among other
 * exchange-level volumes — which means it has limited median influence when
 * exchange volumes are high; this is the intended behavior).
 *
 * Per-source posture:
 *   - rate limit: community-operated; we use 1 rps cap
 *   - ToS: friendly community-operated MIT-licensed project
 *   - No outreach needed
 */

import { BaseSource, type BaseSourceConfig } from "./base";
import type { Candle, HealthStatus, Pair } from "./types";

const FIAT_MAP: Record<string, string> = {
  USD: "USD",
  EUR: "EUR",
  GBP: "GBP",
  CAD: "CAD",
  CHF: "CHF",
  AUD: "AUD",
  JPY: "JPY",
};

// mempool.space reports an aggregate "price" without per-exchange volume.
// We normalize its contribution to 1.0 BTC equivalent in the VW-median —
// it gets equal-weighted with other sources rather than dominating or
// being drowned out. Documented choice; adjustable if needed.
const MEMPOOL_NORMALIZED_VOLUME = 1.0;

export class MempoolSpaceSource extends BaseSource {
  constructor() {
    const cfg: BaseSourceConfig = {
      name: "mempool.space",
      role: "primary",
      endpointBase: "https://mempool.space",
      userAgent: "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)",
      rateLimitRps: 1.0,
      pairsSupported: ["BTC-USD", "BTC-EUR", "BTC-GBP", "BTC-CAD", "BTC-CHF", "BTC-AUD", "BTC-JPY"],
    };
    super(cfg);
  }

  protected async fetchCandles(pair: Pair, _from: Date, to: Date): Promise<Candle[]> {
    if (pair.source !== "BTC") {
      throw new Error(`mempool.space: only BTC source supported, got ${pair.source}`);
    }
    const fiat = FIAT_MAP[pair.target];
    if (!fiat) {
      throw new Error(`mempool.space: unsupported target ${pair.target}`);
    }

    // mempool.space historical-price gives daily data; for minute granularity
    // we use the current /prices and treat it as a snapshot at the most recent
    // minute floor before `to`.
    const url = `${this.endpointBase}/api/v1/prices`;
    const res = await this.httpGet(url);
    const body = (await res.json()) as MempoolPricesResponse;

    const priceVal = body[fiat as keyof MempoolPricesResponse];
    if (typeof priceVal !== "number" || !isFinite(priceVal) || priceVal <= 0) {
      throw new Error(`mempool.space: no valid price for ${fiat} in response`);
    }

    // Snap to the minute floor before `to` (treat the snapshot as covering that bucket)
    const bucketMs = Math.floor(to.getTime() / 60_000) * 60_000 - 60_000;
    const bucketTs = new Date(bucketMs);

    return [{
      bucketTs,
      open: priceVal,
      high: priceVal,
      low: priceVal,
      close: priceVal,
      volume: MEMPOOL_NORMALIZED_VOLUME,
    }];
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.waitForCadence();
      const url = `${this.endpointBase}/api/v1/prices`;
      const res = await this.httpGet(url);
      const body = (await res.json()) as MempoolPricesResponse;
      const reachable = typeof body.USD === "number" && body.USD > 0;
      return {
        name: this.name,
        reachable,
        lastSuccessAt: reachable ? new Date() : undefined,
        lastFailureAt: reachable ? undefined : new Date(),
        lastError: reachable ? undefined : "/prices missing USD field",
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

interface MempoolPricesResponse {
  time?: number;
  USD?: number;
  EUR?: number;
  GBP?: number;
  CAD?: number;
  CHF?: number;
  AUD?: number;
  JPY?: number;
}
