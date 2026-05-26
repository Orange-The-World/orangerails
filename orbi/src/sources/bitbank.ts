/**
 * bitbank source plug-in (BTC/JPY).
 *
 * bitbank, Inc. is a JFSA-licensed Japanese exchange. Their public market
 * API exposes a NATIVE 1-minute candlestick endpoint, indexed by date.
 *
 * Public endpoint:
 *   GET https://public.bitbank.cc/{pair}/candlestick/{type}/{YYYYMMDD}
 *   Returns 1-min candlesticks for the given UTC day:
 *     {
 *       "success": 1,
 *       "data": {
 *         "candlestick": [
 *           {
 *             "type": "1min",
 *             "ohlcv": [
 *               ["open","high","low","close","volume", ts_ms],
 *               ...
 *             ]
 *           }
 *         ],
 *         "timestamp": <ms>
 *       }
 *     }
 *
 * Order of fields in each ohlcv row is OPEN, HIGH, LOW, CLOSE, VOLUME, TS
 * (string-encoded prices/volumes; numeric ms timestamp last).
 *
 * Pair codes (path segment): "btc_jpy", "btc_usdt", "eth_jpy", etc.
 *
 * Per-source posture:
 *   - rate limit: bitbank documents 10 req/sec for public; we use 1 rps.
 *   - free, no auth required.
 *   - tier: primary.
 *
 * Validated empirically 2026-05-26 against
 *   https://public.bitbank.cc/btc_jpy/candlestick/1min/<today>
 * — returned a list of 1-min candles for today (UTC).
 *
 * Multi-day windows: the plug-in fetches one calendar day per request and
 * concatenates. For ORBI's per-minute use case (1-2 min windows) one fetch
 * is sufficient; for backfills crossing a UTC midnight the plug-in fetches
 * both days.
 *
 * See https://github.com/bitbankinc/bitbank-api-docs/blob/master/public-api.md
 * for endpoint reference.
 */

import { BaseSource, type BaseSourceConfig } from "./base";
import type { Candle, HealthStatus, Pair } from "./types";

const PAIR_MAP: Record<string, string> = {
  "BTC-JPY": "btc_jpy",
};

export class BitbankSource extends BaseSource {
  constructor() {
    const cfg: BaseSourceConfig = {
      name: "bitbank",
      role: "primary",
      endpointBase: "https://public.bitbank.cc",
      userAgent:
        "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)",
      rateLimitRps: 1.0,
      pairsSupported: Object.keys(PAIR_MAP),
    };
    super(cfg);
  }

  protected async fetchCandles(pair: Pair, from: Date, to: Date): Promise<Candle[]> {
    const ourPair = `${pair.source}-${pair.target}`;
    const bbPair = PAIR_MAP[ourPair];
    if (!bbPair) {
      throw new Error(`bitbank: unsupported pair ${ourPair}`);
    }

    // Walk one UTC day at a time from `from` to `to`. For most calls this is
    // a single day; for cross-midnight backfills we hit two.
    const days = utcDaysCovered(from, to);
    const fromMs = from.getTime();
    const toMs = to.getTime();
    const allCandles: Candle[] = [];

    for (const ymd of days) {
      const url = `${this.endpointBase}/${bbPair}/candlestick/1min/${ymd}`;
      const res = await this.httpGet(url);
      const body = (await res.json()) as BitbankCandlestickResponse;
      if (body.success !== 1) {
        throw new Error(`bitbank: success=${body.success} for ${ymd}`);
      }
      const inner = body.data?.candlestick?.[0];
      if (!inner || !Array.isArray(inner.ohlcv)) {
        // Day not yet populated (e.g. future day) — skip without erroring.
        continue;
      }
      for (const row of inner.ohlcv) {
        const ts = Number(row[5]);
        if (!isFinite(ts) || ts < fromMs || ts > toMs) continue;
        const open = Number(row[0]);
        const high = Number(row[1]);
        const low = Number(row[2]);
        const close = Number(row[3]);
        const volume = Number(row[4]);
        if (
          !isFinite(open) || !isFinite(high) || !isFinite(low) ||
          !isFinite(close) || !isFinite(volume)
        ) continue;
        allCandles.push({
          bucketTs: new Date(ts),
          open,
          high,
          low,
          close,
          volume,
        });
      }
    }

    allCandles.sort((a, b) => a.bucketTs.getTime() - b.bucketTs.getTime());
    return allCandles;
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.waitForCadence();
      const url = `${this.endpointBase}/btc_jpy/ticker`;
      const res = await this.httpGet(url);
      const body = (await res.json()) as { success?: number; data?: { last?: string } };
      const reachable = body.success === 1 && Number(body.data?.last) > 0;
      return {
        name: this.name,
        reachable,
        lastSuccessAt: reachable ? new Date() : undefined,
        lastFailureAt: reachable ? undefined : new Date(),
        lastError: reachable ? undefined : "ticker missing `last`",
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

/** All UTC dates (YYYYMMDD) intersecting [from, to]. */
export function utcDaysCovered(from: Date, to: Date): string[] {
  const days: string[] = [];
  const start = new Date(Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate(),
  ));
  const end = to.getTime();
  for (let d = start.getTime(); d <= end; d += 86_400_000) {
    const day = new Date(d);
    const y = day.getUTCFullYear().toString().padStart(4, "0");
    const m = (day.getUTCMonth() + 1).toString().padStart(2, "0");
    const dd = day.getUTCDate().toString().padStart(2, "0");
    days.push(`${y}${m}${dd}`);
  }
  return days;
}

interface BitbankCandlestickResponse {
  success?: number;
  data?: {
    candlestick?: Array<{
      type: string;
      ohlcv: Array<[string, string, string, string, string, number]>;
    }>;
    timestamp?: number;
  };
}
