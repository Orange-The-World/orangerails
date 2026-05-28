/**
 * BTC Markets source plug-in (BTC/AUD).
 *
 * BTC Markets is an Australian AUSTRAC-registered exchange. Their public
 * v3 API exposes a NATIVE 1-minute OHLC candles endpoint.
 *
 * Public endpoint:
 *   GET https://api.btcmarkets.net/v3/markets/{marketId}/candles
 *       ?timeWindow=1m&from={ISO}&to={ISO}
 *
 *   Response shape:
 *     [
 *       ["<ts ISO>","<open>","<high>","<low>","<close>","<volume>"],
 *       ...
 *     ]
 *
 *   Order: TS, OPEN, HIGH, LOW, CLOSE, VOLUME (strings except ts).
 *
 * Health endpoint:
 *   GET https://api.btcmarkets.net/v3/markets/BTC-AUD/ticker
 *     → { marketId, bestBid, bestAsk, lastPrice, volume24h, ..., timestamp }
 *
 * Per-source posture:
 *   - rate limit: BTC Markets documents 50 req/10s public; we use 1 rps.
 *   - free, no auth required for /v3/markets/* public endpoints.
 *   - tier: primary.
 *
 * Validated empirically 2026-05-26: returned array of one-minute candles in
 * the requested window.
 *
 * See https://docs.btcmarkets.net/v3/ for endpoint reference.
 */

import { BaseSource, type BaseSourceConfig } from "./base.ts";
import type { Candle, HealthStatus, Pair } from "./types.ts";

const PAIR_MAP: Record<string, string> = {
  "BTC-AUD": "BTC-AUD",
};

export class BtcMarketsSource extends BaseSource {
  constructor() {
    const cfg: BaseSourceConfig = {
      name: "btc_markets",
      role: "primary",
      endpointBase: "https://api.btcmarkets.net",
      userAgent:
        "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)",
      rateLimitRps: 1.0,
      pairsSupported: Object.keys(PAIR_MAP),
    };
    super(cfg);
  }

  protected async fetchCandles(pair: Pair, from: Date, to: Date): Promise<Candle[]> {
    const ourPair = `${pair.source}-${pair.target}`;
    const marketId = PAIR_MAP[ourPair];
    if (!marketId) {
      throw new Error(`BTC Markets: unsupported pair ${ourPair}`);
    }

    const fromIso = from.toISOString();
    const toIso = to.toISOString();
    const url =
      `${this.endpointBase}/v3/markets/${marketId}/candles` +
      `?timeWindow=1m&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`;

    const res = await this.httpGet(url);
    const body = (await res.json()) as BtcMarketsCandleRow[];
    if (!Array.isArray(body)) {
      throw new Error("BTC Markets: candles response not an array");
    }

    const fromMs = from.getTime();
    const toMs = to.getTime();
    const candles: Candle[] = [];
    for (const row of body) {
      const ts = new Date(row[0]).getTime();
      if (!isFinite(ts) || ts < fromMs || ts > toMs) continue;
      const open = Number(row[1]);
      const high = Number(row[2]);
      const low = Number(row[3]);
      const close = Number(row[4]);
      const volume = Number(row[5]);
      if (
        !isFinite(open) || !isFinite(high) || !isFinite(low) ||
        !isFinite(close) || !isFinite(volume)
      ) continue;
      candles.push({ bucketTs: new Date(ts), open, high, low, close, volume });
    }
    candles.sort((a, b) => a.bucketTs.getTime() - b.bucketTs.getTime());
    return candles;
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.waitForCadence();
      const url = `${this.endpointBase}/v3/markets/BTC-AUD/ticker`;
      const res = await this.httpGet(url);
      const body = (await res.json()) as { lastPrice?: string };
      const reachable = Number(body?.lastPrice) > 0;
      return {
        name: this.name,
        reachable,
        lastSuccessAt: reachable ? new Date() : undefined,
        lastFailureAt: reachable ? undefined : new Date(),
        lastError: reachable ? undefined : "ticker missing lastPrice",
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

/** BTC Markets candle row: [ts ISO, open, high, low, close, volume] (strings). */
type BtcMarketsCandleRow = [string, string, string, string, string, string];
