/**
 * Ripio source plug-in (BTC/ARS) — ticker-only / B-single-eligible-only.
 *
 * Ripio is an Argentina-headquartered exchange (CNV-registered, also operates
 * in Brazil/Colombia/Uruguay). Their public rates endpoint exposes a SNAPSHOT
 * of buy/sell rates for every market they list, but no OHLC and no per-trade
 * history without a registered account.
 *
 * Public endpoint:
 *   GET https://app.ripio.com/api/v3/rates/?country=AR
 *     → [
 *         { "ticker": "BTC_ARS", "buy_rate": "...", "sell_rate": "...", "variation": "..." },
 *         { "ticker": "BTC_USD", ... },
 *         ...
 *       ]
 *
 * The plug-in picks BTC_ARS, mid-price = (buy_rate + sell_rate) / 2, and
 * emits a single zero-volume candle snapped to the minute floor before `to`.
 *
 * Tier: B-single-eligible-only (zero-volume → not voting in VW-median).
 *
 * Per-source posture:
 *   - rate limit: not documented; the endpoint serves the entire rates table
 *     in one shot so 1 rps is plenty.
 *   - free, no auth required.
 *   - tier: primary (B-single-eligible-only at resolver).
 *
 * Validated empirically 2026-05-26.
 *
 * See https://app.ripio.com/ (no public API docs site — endpoint observed
 * from their public web rate widget).
 */

import { BaseSource, type BaseSourceConfig } from "./base";
import type { Candle, HealthStatus, Pair } from "./types";

const PAIR_MAP: Record<string, string> = {
  "BTC-ARS": "BTC_ARS",
};

export class RipioSource extends BaseSource {
  constructor() {
    const cfg: BaseSourceConfig = {
      name: "ripio",
      role: "primary",
      endpointBase: "https://app.ripio.com",
      userAgent:
        "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)",
      rateLimitRps: 1.0,
      pairsSupported: Object.keys(PAIR_MAP),
    };
    super(cfg);
  }

  protected async fetchCandles(pair: Pair, _from: Date, to: Date): Promise<Candle[]> {
    const ourPair = `${pair.source}-${pair.target}`;
    const ticker = PAIR_MAP[ourPair];
    if (!ticker) {
      throw new Error(`Ripio: unsupported pair ${ourPair}`);
    }

    const url = `${this.endpointBase}/api/v3/rates/?country=AR`;
    const res = await this.httpGet(url);
    const body = (await res.json()) as RipioRate[];
    if (!Array.isArray(body)) {
      throw new Error("Ripio: rates response not an array");
    }
    const row = body.find((r) => r.ticker === ticker);
    if (!row) {
      throw new Error(`Ripio: ticker ${ticker} not found in rates`);
    }
    const buy = Number(row.buy_rate);
    const sell = Number(row.sell_rate);
    if (!isFinite(buy) || buy <= 0 || !isFinite(sell) || sell <= 0) {
      throw new Error(`Ripio: invalid buy/sell rates for ${ticker}`);
    }
    const mid = (buy + sell) / 2;
    const bucketMs = Math.floor(to.getTime() / 60_000) * 60_000 - 60_000;
    return [{
      bucketTs: new Date(bucketMs),
      open: mid,
      high: mid,
      low: mid,
      close: mid,
      volume: 0,
    }];
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.waitForCadence();
      const url = `${this.endpointBase}/api/v3/rates/?country=AR`;
      const res = await this.httpGet(url);
      const body = (await res.json()) as RipioRate[];
      const row = body.find((r) => r.ticker === "BTC_ARS");
      const reachable = !!row && Number(row.buy_rate) > 0;
      return {
        name: this.name,
        reachable,
        lastSuccessAt: reachable ? new Date() : undefined,
        lastFailureAt: reachable ? undefined : new Date(),
        lastError: reachable ? undefined : "rates missing BTC_ARS",
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

interface RipioRate {
  ticker: string;
  base_currency_balance_id?: number;
  quote_currency_balance_id?: number;
  buy_rate?: string;
  sell_rate?: string;
  variation?: string;
}
