/**
 * BTSE source plug-in.
 *
 * BTSE (BVI-incorporated, VASP-registered in several jurisdictions) is a
 * mid-tier spot exchange that natively quotes BTC against an unusually wide
 * fiat basket including HKD. The Hong Kong pair is liquid (52M HKD 24h
 * volume on the day of plug-in addition); the rest of BTSE's fiat pairs
 * are either redundant with stronger venues or essentially dormant.
 *
 * Endpoint: GET https://api.btse.com/spot/api/v3.2/ohlcv
 *   ?symbol={symbol}&resolution=1&start={unix_sec}&end={unix_sec}
 *
 * Response shape:
 *   [[unix_seconds, open, high, low, close, volume], ...]
 *   Returned MOST-RECENT-FIRST.
 *
 * Health endpoint:
 *   GET https://api.btse.com/spot/api/v3.2/market_summary?symbol=BTC-HKD
 *     → [ { symbol, last, lowestAsk, highestBid, volume, ... } ]
 *
 * Pair coverage enabled here:
 *   - BTC-HKD: liquid, active. Validated 2026-05-27 (last 587263 HKD,
 *     24h volume 52,894,528 HKD).
 *
 *   BTC-NZD is listed by BTSE but volume is zero (stale ticker last quote
 *   2025); we get our BTC/NZD candles from Independent Reserve and would
 *   gain nothing from a zero-volume duplicate.
 *
 * Per-source posture:
 *   - rate limit: BTSE publishes 5 req/sec for the public market endpoints;
 *     we cap to 1 rps for headroom.
 *   - free, no auth required for /spot/api/v3.2/ohlcv and /market_summary.
 *   - tier: primary.
 *
 * See https://www.btse.com/apexDocs/spot/swagger-ui/ for endpoint reference.
 */

import { BaseSource, type BaseSourceConfig } from "./base";
import type { Candle, HealthStatus, Pair } from "./types";

const PAIR_MAP: Record<string, string> = {
  "BTC-HKD": "BTC-HKD",
};

export class BtseSource extends BaseSource {
  constructor() {
    const cfg: BaseSourceConfig = {
      name: "btse",
      role: "primary",
      endpointBase: "https://api.btse.com",
      userAgent:
        "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)",
      rateLimitRps: 1.0,
      pairsSupported: Object.keys(PAIR_MAP),
    };
    super(cfg);
  }

  protected async fetchCandles(pair: Pair, from: Date, to: Date): Promise<Candle[]> {
    const ourPair = `${pair.source}-${pair.target}`;
    const symbol = PAIR_MAP[ourPair];
    if (!symbol) {
      throw new Error(`BTSE: unsupported pair ${ourPair}`);
    }

    const startSec = Math.floor(from.getTime() / 1000);
    const endSec = Math.ceil(to.getTime() / 1000);
    const url =
      `${this.endpointBase}/spot/api/v3.2/ohlcv` +
      `?symbol=${encodeURIComponent(symbol)}&resolution=1` +
      `&start=${startSec}&end=${endSec}`;

    const res = await this.httpGet(url);
    const body = (await res.json()) as BtseCandleTuple[];

    if (!Array.isArray(body)) {
      throw new Error(`BTSE: unexpected response shape (not an array) for ${symbol}`);
    }

    const fromMs = from.getTime();
    const toMs = to.getTime();
    const candles: Candle[] = [];
    for (const tuple of body) {
      const tsSec = Number(tuple[0]);
      const ts = tsSec * 1000;
      if (!isFinite(ts) || ts < fromMs || ts > toMs) continue;
      const open = Number(tuple[1]);
      const high = Number(tuple[2]);
      const low = Number(tuple[3]);
      const close = Number(tuple[4]);
      const volume = Number(tuple[5]);
      if (!isFinite(open) || !isFinite(close) || open <= 0 || close <= 0) continue;
      candles.push({
        bucketTs: new Date(ts),
        open,
        high,
        low,
        close,
        volume,
      });
    }
    return candles;
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.waitForCadence();
      const url = `${this.endpointBase}/spot/api/v3.2/market_summary?symbol=BTC-HKD`;
      const res = await this.httpGet(url);
      const body = (await res.json()) as Array<{ last?: number; active?: boolean }>;
      const row = Array.isArray(body) ? body[0] : undefined;
      const reachable =
        !!row && typeof row.last === "number" && row.last > 0 && row.active !== false;
      return {
        name: this.name,
        reachable,
        lastSuccessAt: reachable ? new Date() : undefined,
        lastFailureAt: reachable ? undefined : new Date(),
        lastError: reachable ? undefined : "BTSE market_summary missing last or inactive",
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

/** BTSE OHLCV tuple: [unix_seconds, open, high, low, close, volume]. */
type BtseCandleTuple = [number, number, number, number, number, number];
