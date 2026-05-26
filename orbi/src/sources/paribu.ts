/**
 * Paribu source plug-in (BTC/TRY) — ticker-only / B-single-eligible-only.
 *
 * Paribu is a major Turkish exchange. Their public `/ticker` endpoint returns
 * a snapshot for every market but does NOT expose OHLC or per-trade history
 * without a registered account. As a result, this plug-in:
 *
 *   - Emits exactly ONE candle per fetch, snapped to the minute floor before
 *     `to`, with open=high=low=close=ticker_last.
 *   - Reports volume = 0 (24h volume is in the ticker, but it is NOT a
 *     per-minute volume — treating it as such would dominate the VW-median).
 *     Per the existing project convention, zero-volume candles are dropped
 *     from the volume-weighted median, so Paribu's contribution is fixing
 *     diversity-only (e.g. for B-single fallback) rather than VW-median
 *     voting. The forward-fill / resolver wiring decides how to count it.
 *
 *   Tier classification: B-single-eligible-only.
 *
 * Public endpoint:
 *   GET https://www.paribu.com/ticker
 *     → { "BTC_TL": { lowestAsk, highestBid, low24hr, high24hr, last,
 *                     volume, change, percentChange, chartData }, ... }
 *
 *   `BTC_TL` is the Paribu pair code for BTC/TRY (TL = Turkish Lira). The
 *   `chartData` field is present but empty in the public response — it
 *   appears to be populated only for authenticated callers.
 *
 * Per-source posture:
 *   - rate limit: not documented; the endpoint serves the entire ticker in
 *     one shot so a 1 rps cap is plenty.
 *   - free, no auth required.
 *   - tier: primary (with B-single-eligible-only role at the resolver).
 *
 * Validated empirically 2026-05-26: BTC_TL keys present in /ticker JSON.
 *
 * See https://www.paribu.com/ (no public API docs site — endpoint is the
 * one consumed by their public web ticker widget).
 */

import { BaseSource, type BaseSourceConfig } from "./base";
import type { Candle, HealthStatus, Pair } from "./types";

const PAIR_MAP: Record<string, string> = {
  "BTC-TRY": "BTC_TL",
};

export class ParibuSource extends BaseSource {
  constructor() {
    const cfg: BaseSourceConfig = {
      name: "paribu",
      role: "primary",
      endpointBase: "https://www.paribu.com",
      userAgent:
        "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)",
      rateLimitRps: 1.0,
      pairsSupported: Object.keys(PAIR_MAP),
    };
    super(cfg);
  }

  protected async fetchCandles(pair: Pair, _from: Date, to: Date): Promise<Candle[]> {
    const ourPair = `${pair.source}-${pair.target}`;
    const paribuKey = PAIR_MAP[ourPair];
    if (!paribuKey) {
      throw new Error(`Paribu: unsupported pair ${ourPair}`);
    }

    const url = `${this.endpointBase}/ticker`;
    const res = await this.httpGet(url);
    const body = (await res.json()) as Record<string, ParibuTickerEntry>;
    const entry = body?.[paribuKey];
    if (!entry || typeof entry.last !== "number" || !isFinite(entry.last) || entry.last <= 0) {
      throw new Error(`Paribu: missing/invalid last for ${paribuKey}`);
    }

    const bucketMs = Math.floor(to.getTime() / 60_000) * 60_000 - 60_000;
    return [{
      bucketTs: new Date(bucketMs),
      open: entry.last,
      high: entry.last,
      low: entry.last,
      close: entry.last,
      // 0 volume → not voting in VW-median; eligible for B-single only.
      volume: 0,
    }];
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.waitForCadence();
      const url = `${this.endpointBase}/ticker`;
      const res = await this.httpGet(url);
      const body = (await res.json()) as Record<string, ParibuTickerEntry>;
      const reachable = typeof body?.BTC_TL?.last === "number" && body.BTC_TL.last > 0;
      return {
        name: this.name,
        reachable,
        lastSuccessAt: reachable ? new Date() : undefined,
        lastFailureAt: reachable ? undefined : new Date(),
        lastError: reachable ? undefined : "ticker missing BTC_TL.last",
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

interface ParibuTickerEntry {
  lowestAsk?: number;
  highestBid?: number;
  low24hr?: number;
  high24hr?: number;
  avg24hr?: number;
  volume?: number;
  last?: number;
  change?: number;
  percentChange?: number;
  chartData?: unknown[];
}
