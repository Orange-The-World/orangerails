/**
 * Luno source plug-in (BTC/ZAR) — ticker-only / B-single-eligible-only.
 *
 * IMPORTANT (validated empirically 2026-05-26): Luno's documented public
 * candles endpoint
 *
 *   GET https://api.luno.com/api/exchange/1/candles
 *
 * RETURNS HTTP 401 / "authentication failure, type mismatch" for unauthenticated
 * callers. The brief assumed it was keyless; that is no longer the case.
 *
 * Luno's keyless public endpoints DO include:
 *   - GET https://api.luno.com/api/1/ticker?pair=XBTZAR
 *       → { pair, timestamp, bid, ask, last_trade, rolling_24_hour_volume, status }
 *
 * As a result this plug-in:
 *   - Uses /api/1/ticker for the BTC-ZAR snapshot.
 *   - Emits one candle per fetch, snapped to the minute floor before `to`,
 *     open=high=low=close=last_trade. Volume = 0 (24h volume is not per-min).
 *
 *   Tier: B-single-eligible-only. ZAR direct coverage requires VALR to vote
 *   in the VW-median; Luno backs that up for diversity / fallback.
 *
 * To upgrade Luno to Tier A voting later: register a free Luno API key
 * (read-only Trade scope is sufficient for /candles); add to founder
 * credentials checklist.
 *
 * Per-source posture:
 *   - rate limit: Luno documents 300 req/min for public endpoints (5 rps);
 *     we use 1 rps for headroom.
 *   - free, no auth required for /api/1/ticker.
 *   - tier: primary (B-single-eligible-only at resolver).
 *
 * See https://www.luno.com/en/developers/api for endpoint reference.
 */

import { BaseSource, type BaseSourceConfig } from "./base.ts";
import type { Candle, HealthStatus, Pair } from "./types.ts";

const PAIR_MAP: Record<string, string> = {
  "BTC-ZAR": "XBTZAR",
};

export class LunoSource extends BaseSource {
  constructor() {
    const cfg: BaseSourceConfig = {
      name: "luno",
      role: "primary",
      endpointBase: "https://api.luno.com",
      userAgent:
        "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)",
      rateLimitRps: 1.0,
      pairsSupported: Object.keys(PAIR_MAP),
    };
    super(cfg);
  }

  protected async fetchCandles(pair: Pair, _from: Date, to: Date): Promise<Candle[]> {
    const ourPair = `${pair.source}-${pair.target}`;
    const lunoPair = PAIR_MAP[ourPair];
    if (!lunoPair) {
      throw new Error(`Luno: unsupported pair ${ourPair}`);
    }

    const url = `${this.endpointBase}/api/1/ticker?pair=${lunoPair}`;
    const res = await this.httpGet(url);
    const body = (await res.json()) as LunoTickerResponse;
    const last = Number(body?.last_trade);
    if (!isFinite(last) || last <= 0) {
      throw new Error(`Luno: missing/invalid last_trade for ${lunoPair}`);
    }

    const bucketMs = Math.floor(to.getTime() / 60_000) * 60_000 - 60_000;
    return [{
      bucketTs: new Date(bucketMs),
      open: last,
      high: last,
      low: last,
      close: last,
      volume: 0,
    }];
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.waitForCadence();
      const url = `${this.endpointBase}/api/1/ticker?pair=XBTZAR`;
      const res = await this.httpGet(url);
      const body = (await res.json()) as LunoTickerResponse;
      const reachable = Number(body?.last_trade) > 0 && body?.status !== "POSTONLY";
      return {
        name: this.name,
        reachable,
        lastSuccessAt: reachable ? new Date() : undefined,
        lastFailureAt: reachable ? undefined : new Date(),
        lastError: reachable
          ? undefined
          : `ticker status=${body?.status} last_trade=${body?.last_trade}`,
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

interface LunoTickerResponse {
  pair?: string;
  timestamp?: number;
  bid?: string;
  ask?: string;
  last_trade?: string;
  rolling_24_hour_volume?: string;
  status?: string;
}
