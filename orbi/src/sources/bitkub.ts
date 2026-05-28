/**
 * Bitkub source plug-in (BTC/THB).
 *
 * Bitkub is Thailand's largest SEC-licensed centralized exchange (operated
 * by Bitkub Online Co., Ltd.). They publish a v3 public market REST API
 * that exposes recent trades for spot symbols. There is no public OHLC
 * endpoint; we synthesize 1-minute OHLC bars from the recent-trades feed,
 * the same approach used for Coincheck, Bitso, and Independent Reserve.
 *
 * Public endpoints used:
 *   - GET https://api.bitkub.com/api/v3/market/trades?sym=btc_thb&lmt=N
 *       Recent trades. Response:
 *         {
 *           "error": 0,
 *           "result": [
 *             [ <unix-seconds>, <price>, <amount-btc>, <"BUY"|"SELL"> ],
 *             ...
 *           ]
 *         }
 *       Most-recent first.
 *   - GET https://api.bitkub.com/api/v3/market/ticker?sym=btc_thb (health)
 *       Response: [ { symbol, last, base_volume, quote_volume, ... } ]
 *
 * Pair handling:
 *   - Only BTC-THB is supported by this plug-in.
 *
 * Per-source posture:
 *   - rate limit: Bitkub documents 250 requests per 10 seconds (~25 rps);
 *     we cap to 1 rps for headroom.
 *   - free, no auth required for public endpoints.
 *   - tier: primary.
 *
 * Validated empirically 2026-05-27 — /api/v3/market/trades returned a fresh
 * fill array and /api/v3/market/ticker reported last 2,410,018 THB with
 * 99.20 BTC of 24h base volume.
 *
 * See https://github.com/bitkub/bitkub-official-api-docs for endpoint
 * reference.
 */

import { BaseSource, type BaseSourceConfig } from "./base.ts";
import { aggregateTradesToCandles } from "./trades-aggregation.ts";
import type { Candle, HealthStatus, Pair } from "./types.ts";

const PAIR_MAP: Record<string, string> = {
  "BTC-THB": "btc_thb",
};

export class BitkubSource extends BaseSource {
  constructor() {
    const cfg: BaseSourceConfig = {
      name: "bitkub",
      role: "primary",
      endpointBase: "https://api.bitkub.com",
      userAgent:
        "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)",
      rateLimitRps: 1.0,
      pairsSupported: Object.keys(PAIR_MAP),
    };
    super(cfg);
  }

  protected async fetchCandles(pair: Pair, from: Date, to: Date): Promise<Candle[]> {
    const ourPair = `${pair.source}-${pair.target}`;
    const bkPair = PAIR_MAP[ourPair];
    if (!bkPair) {
      throw new Error(`Bitkub: unsupported pair ${ourPair}`);
    }

    const url = `${this.endpointBase}/api/v3/market/trades?sym=${bkPair}&lmt=100`;
    const res = await this.httpGet(url);
    const body = (await res.json()) as BitkubTradesResponse;
    if (body.error !== 0 || !Array.isArray(body.result)) {
      throw new Error(`Bitkub: trades response error=${body.error}`);
    }

    const fromMs = from.getTime();
    const toMs = to.getTime();
    const trades: Array<{ ts: number; price: number; amount: number }> = [];
    for (const row of body.result) {
      if (!Array.isArray(row) || row.length < 4) continue;
      const ts = Number(row[0]) * 1000;
      const price = Number(row[1]);
      const amount = Number(row[2]);
      if (!isFinite(ts) || ts < fromMs || ts > toMs) continue;
      if (!isFinite(price) || price <= 0 || !isFinite(amount) || amount <= 0) continue;
      trades.push({ ts, price, amount });
    }
    if (trades.length === 0) return [];
    trades.sort((a, b) => a.ts - b.ts);
    return aggregateTradesToCandles(trades);
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.waitForCadence();
      const url = `${this.endpointBase}/api/v3/market/ticker?sym=btc_thb`;
      const res = await this.httpGet(url);
      const body = (await res.json()) as BitkubTickerRow[];
      const row = Array.isArray(body) ? body[0] : undefined;
      const last = row ? Number(row.last) : NaN;
      const reachable = isFinite(last) && last > 0;
      return {
        name: this.name,
        reachable,
        lastSuccessAt: reachable ? new Date() : undefined,
        lastFailureAt: reachable ? undefined : new Date(),
        lastError: reachable ? undefined : "Bitkub ticker missing/invalid `last`",
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

interface BitkubTradesResponse {
  error: number;
  result?: Array<[number, number, number, string]>;
}

interface BitkubTickerRow {
  symbol?: string;
  last?: string | number;
  base_volume?: string;
  quote_volume?: string;
}
