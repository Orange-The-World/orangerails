/**
 * Upbit source plug-in (BTC/KRW).
 *
 * Upbit (operated by Dunamu) is South Korea's largest KRW-denominated
 * exchange. Their public market API exposes a NATIVE 1-minute candles
 * endpoint, keyless.
 *
 * Public endpoint:
 *   GET https://api.upbit.com/v1/candles/minutes/1?market=KRW-BTC&count=N
 *       &to={UTC ISO} (optional — defaults to now)
 *
 *   Response: array, MOST-RECENT-FIRST:
 *     [
 *       {
 *         "market": "KRW-BTC",
 *         "candle_date_time_utc": "2026-05-26T22:35:00",
 *         "candle_date_time_kst": "2026-05-27T07:35:00",
 *         "opening_price": 112601000,
 *         "high_price":    112601000,
 *         "low_price":     112600000,
 *         "trade_price":   112601000,   // ← close
 *         "timestamp":     1779834912320,
 *         "candle_acc_trade_price":   53497350.94841,
 *         "candle_acc_trade_volume":  0.47510570,
 *         "unit": 1
 *       },
 *       ...
 *     ]
 *
 * Per-source posture:
 *   - rate limit: Upbit documents ~10 req/sec public; we use 1 rps for headroom.
 *   - free, no auth required for /v1/candles/* and /v1/ticker.
 *   - tier: primary.
 *
 * Validated empirically 2026-05-26 against
 *   https://api.upbit.com/v1/candles/minutes/1?market=KRW-BTC&count=3
 *
 * See https://docs.upbit.com/reference/ for endpoint reference.
 */

import { BaseSource, type BaseSourceConfig } from "./base.ts";
import type { Candle, HealthStatus, Pair } from "./types.ts";

const PAIR_MAP: Record<string, string> = {
  "BTC-KRW": "KRW-BTC", // Upbit lists as quote-first
};

export class UpbitSource extends BaseSource {
  constructor() {
    const cfg: BaseSourceConfig = {
      name: "upbit",
      role: "primary",
      endpointBase: "https://api.upbit.com",
      userAgent:
        "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)",
      rateLimitRps: 1.0,
      pairsSupported: Object.keys(PAIR_MAP),
    };
    super(cfg);
  }

  protected async fetchCandles(pair: Pair, from: Date, to: Date): Promise<Candle[]> {
    const ourPair = `${pair.source}-${pair.target}`;
    const upbitMarket = PAIR_MAP[ourPair];
    if (!upbitMarket) {
      throw new Error(`Upbit: unsupported pair ${ourPair}`);
    }

    // Compute count from window width, capped to Upbit's per-request max (200).
    const windowMinutes = Math.ceil((to.getTime() - from.getTime()) / 60_000);
    const count = Math.max(1, Math.min(200, windowMinutes + 2));
    const toIso = to.toISOString().replace(/\.\d{3}Z$/, "Z");
    const url =
      `${this.endpointBase}/v1/candles/minutes/1` +
      `?market=${upbitMarket}&count=${count}&to=${encodeURIComponent(toIso)}`;

    const res = await this.httpGet(url);
    const body = (await res.json()) as UpbitCandle[];
    if (!Array.isArray(body)) {
      throw new Error("Upbit: candles response not an array");
    }

    const fromMs = from.getTime();
    const toMs = to.getTime();
    const candles: Candle[] = [];
    for (const c of body) {
      // candle_date_time_utc lacks trailing 'Z'; force UTC parse
      const ts = new Date(c.candle_date_time_utc + "Z").getTime();
      if (!isFinite(ts) || ts < fromMs || ts > toMs) continue;
      const open = Number(c.opening_price);
      const high = Number(c.high_price);
      const low = Number(c.low_price);
      const close = Number(c.trade_price);
      const volume = Number(c.candle_acc_trade_volume);
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
      const url = `${this.endpointBase}/v1/ticker?markets=KRW-BTC`;
      const res = await this.httpGet(url);
      const body = (await res.json()) as Array<{ trade_price?: number }>;
      const reachable = Number(body?.[0]?.trade_price) > 0;
      return {
        name: this.name,
        reachable,
        lastSuccessAt: reachable ? new Date() : undefined,
        lastFailureAt: reachable ? undefined : new Date(),
        lastError: reachable ? undefined : "ticker missing trade_price",
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

interface UpbitCandle {
  market: string;
  candle_date_time_utc: string;
  candle_date_time_kst: string;
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number;
  timestamp: number;
  candle_acc_trade_price: number;
  candle_acc_trade_volume: number;
  unit: number;
}
