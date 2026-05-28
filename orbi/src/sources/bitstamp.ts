/**
 * Bitstamp source plug-in.
 *
 * Endpoint: GET https://www.bitstamp.net/api/v2/ohlc/{pair}/?step=60&limit=N&start=unix
 *
 * Response shape:
 *   {
 *     "data": {
 *       "pair": "BTC/USD",
 *       "ohlc": [
 *         {"timestamp": "1738900000", "open": "97200", "high": "97250",
 *          "low": "97180", "close": "97225", "volume": "18.42"},
 *         ...
 *       ]
 *     }
 *   }
 *
 * Per-source posture:
 *   - rate limit: 400 req/sec; 10,000 / 10 min. We use 2 rps cap (very generous headroom)
 *   - ToS: positive language permits derived statistical works subject to DLA
 *   - DLA email deferred to Phase 3 commercial trigger (free public API covers internal use)
 *
 * Pair codes: lowercased with no separator (btcusd, btceur, btcgbp).
 */

import { BaseSource, type BaseSourceConfig } from "./base.ts";
import type { Candle, HealthStatus, Pair } from "./types.ts";

const PAIR_MAP: Record<string, string> = {
  "BTC-USD": "btcusd",
  "BTC-EUR": "btceur",
  "BTC-GBP": "btcgbp",
};

export class BitstampSource extends BaseSource {
  constructor() {
    const cfg: BaseSourceConfig = {
      name: "bitstamp",
      role: "primary",
      endpointBase: "https://www.bitstamp.net/api/v2",
      userAgent: "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)",
      rateLimitRps: 2.0,
      pairsSupported: Object.keys(PAIR_MAP),
    };
    super(cfg);
  }

  protected async fetchCandles(pair: Pair, from: Date, to: Date): Promise<Candle[]> {
    const ourPair = `${pair.source}-${pair.target}`;
    const bsPair = PAIR_MAP[ourPair];
    if (!bsPair) {
      throw new Error(`Bitstamp: unsupported pair ${ourPair}`);
    }

    // Bitstamp's `start` is unix-seconds; `step=60` = 1-min candles; max limit=1000
    const startSec = Math.floor(from.getTime() / 1000);
    const limit = Math.min(
      Math.ceil((to.getTime() - from.getTime()) / 60_000) + 5,
      1000,
    );
    const url = `${this.endpointBase}/ohlc/${bsPair}/?step=60&limit=${limit}&start=${startSec}`;
    const res = await this.httpGet(url);
    const body = (await res.json()) as BitstampOhlcResponse;

    if (!body.data?.ohlc) {
      throw new Error(`Bitstamp: missing data.ohlc in response`);
    }

    const toMs = to.getTime();
    const candles: Candle[] = [];
    for (const row of body.data.ohlc) {
      const bucketTs = new Date(Number(row.timestamp) * 1000);
      if (bucketTs.getTime() > toMs) continue;
      candles.push({
        bucketTs,
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
      });
    }
    return candles;
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.waitForCadence();
      // Bitstamp's ticker is a cheap health probe
      const url = `${this.endpointBase}/ticker/btcusd/`;
      const res = await this.httpGet(url);
      const body = (await res.json()) as Record<string, unknown>;
      const reachable = typeof body.last === "string" || typeof body.last === "number";
      return {
        name: this.name,
        reachable,
        lastSuccessAt: reachable ? new Date() : undefined,
        lastFailureAt: reachable ? undefined : new Date(),
        lastError: reachable ? undefined : "ticker response missing 'last' field",
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

interface BitstampOhlcResponse {
  data?: {
    pair?: string;
    ohlc?: Array<{
      timestamp: string;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
    }>;
  };
}
