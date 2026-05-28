/**
 * Bithumb source plug-in (BTC/KRW).
 *
 * Bithumb is a long-running South Korean KRW-denominated exchange. Their
 * public market API exposes a NATIVE 1-minute candlestick endpoint, keyless.
 *
 * Public endpoint:
 *   GET https://api.bithumb.com/public/candlestick/{order_currency}_{payment_currency}/1m
 *
 *   Response shape:
 *     {
 *       "status": "0000",            // "0000" = success
 *       "data": [
 *         [ ts_ms,                    // bucket open time, ms
 *           "<open>", "<close>",      // ← note: OPEN, CLOSE, HIGH, LOW order
 *           "<high>", "<low>",
 *           "<volume>" ],
 *         ...
 *       ]
 *     }
 *
 * IMPORTANT ORDER: Bithumb returns OPEN, CLOSE, HIGH, LOW, VOLUME — NOT the
 * conventional OHLCV order. Easy bug if not careful.
 *
 * Per-source posture:
 *   - rate limit: Bithumb documents ~150 req/sec public; we use 1 rps.
 *   - free, no auth required for /public/* endpoints.
 *   - tier: primary.
 *
 * Validated empirically 2026-05-26.
 *
 * See https://apidocs.bithumb.com/ for endpoint reference.
 */

import { BaseSource, type BaseSourceConfig } from "./base.ts";
import type { Candle, HealthStatus, Pair } from "./types.ts";

const PAIR_MAP: Record<string, string> = {
  "BTC-KRW": "BTC_KRW",
};

export class BithumbSource extends BaseSource {
  constructor() {
    const cfg: BaseSourceConfig = {
      name: "bithumb",
      role: "primary",
      endpointBase: "https://api.bithumb.com",
      userAgent:
        "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)",
      rateLimitRps: 1.0,
      pairsSupported: Object.keys(PAIR_MAP),
    };
    super(cfg);
  }

  protected async fetchCandles(pair: Pair, from: Date, to: Date): Promise<Candle[]> {
    const ourPair = `${pair.source}-${pair.target}`;
    const bhPair = PAIR_MAP[ourPair];
    if (!bhPair) {
      throw new Error(`Bithumb: unsupported pair ${ourPair}`);
    }

    const url = `${this.endpointBase}/public/candlestick/${bhPair}/1m`;
    const res = await this.httpGet(url);
    const body = (await res.json()) as BithumbCandlestickResponse;
    if (body.status !== "0000" || !Array.isArray(body.data)) {
      throw new Error(`Bithumb: status=${body.status} or missing data`);
    }

    const fromMs = from.getTime();
    const toMs = to.getTime();
    const candles: Candle[] = [];
    for (const row of body.data) {
      const ts = Number(row[0]);
      if (!isFinite(ts) || ts < fromMs || ts > toMs) continue;
      // ORDER: ts, OPEN, CLOSE, HIGH, LOW, VOLUME
      const open = Number(row[1]);
      const close = Number(row[2]);
      const high = Number(row[3]);
      const low = Number(row[4]);
      const volume = Number(row[5]);
      if (
        !isFinite(open) || !isFinite(close) || !isFinite(high) ||
        !isFinite(low) || !isFinite(volume)
      ) continue;
      candles.push({ bucketTs: new Date(ts), open, high, low, close, volume });
    }
    candles.sort((a, b) => a.bucketTs.getTime() - b.bucketTs.getTime());
    return candles;
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.waitForCadence();
      const url = `${this.endpointBase}/public/ticker/BTC_KRW`;
      const res = await this.httpGet(url);
      const body = (await res.json()) as {
        status?: string;
        data?: { closing_price?: string };
      };
      const reachable = body.status === "0000" && Number(body.data?.closing_price) > 0;
      return {
        name: this.name,
        reachable,
        lastSuccessAt: reachable ? new Date() : undefined,
        lastFailureAt: reachable ? undefined : new Date(),
        lastError: reachable ? undefined : `ticker status=${body.status}`,
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

/** Bithumb row: [ts_ms, open, close, high, low, volume]. */
type BithumbCandleRow = [number, string, string, string, string, string];

interface BithumbCandlestickResponse {
  status?: string;
  data?: BithumbCandleRow[];
}
