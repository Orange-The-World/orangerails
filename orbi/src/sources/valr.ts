/**
 * VALR source plug-in (BTC/ZAR).
 *
 * VALR is a South African FSCA-licensed exchange. Empirical testing
 * 2026-05-26 confirms the documented public `/v1/public/{pair}/ohlc` endpoint
 * returns HTTP 404 (likely deprecated or auth-gated). The public TRADES
 * endpoint works keyless:
 *
 *   GET https://api.valr.com/v1/public/BTCZAR/trades?limit=N
 *     → [
 *         {
 *           "price": "1252479",
 *           "quantity": "0.0001556",
 *           "currencyPair": "BTCZAR",
 *           "tradedAt": "2026-05-26T22:23:47.266Z",
 *           "takerSide": "sell",
 *           "sequenceId": ...,
 *           "id": "...",
 *           "quoteVolume": "194.88..."
 *         },
 *         ...
 *       ]
 *
 * The plug-in synthesizes 1-minute OHLC bars from these ticks (same
 * pattern as Bitso, Coincheck, Independent Reserve).
 *
 * Per-source posture:
 *   - rate limit: VALR documents 600 req/min for public endpoints (10 rps);
 *     we use 1 rps for headroom.
 *   - free, no auth required for /v1/public/* endpoints.
 *   - tier: primary.
 *
 * Validated empirically 2026-05-26:
 *   - /v1/public/BTCZAR/ohlc → 404 (cannot use without API key)
 *   - /v1/public/BTCZAR/trades → 200, recent trades returned
 *   - /v1/public/BTCZAR/marketsummary → 200, used for health check
 *
 * See https://docs.valr.com/ for endpoint reference.
 */

import { BaseSource, type BaseSourceConfig } from "./base";
import { aggregateTradesToCandles } from "./trades-aggregation";
import type { Candle, HealthStatus, Pair } from "./types";

const PAIR_MAP: Record<string, string> = {
  "BTC-ZAR": "BTCZAR",
};

export class ValrSource extends BaseSource {
  constructor() {
    const cfg: BaseSourceConfig = {
      name: "valr",
      role: "primary",
      endpointBase: "https://api.valr.com",
      userAgent:
        "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)",
      rateLimitRps: 1.0,
      pairsSupported: Object.keys(PAIR_MAP),
    };
    super(cfg);
  }

  protected async fetchCandles(pair: Pair, from: Date, to: Date): Promise<Candle[]> {
    const ourPair = `${pair.source}-${pair.target}`;
    const valrPair = PAIR_MAP[ourPair];
    if (!valrPair) {
      throw new Error(`VALR: unsupported pair ${ourPair}`);
    }

    const url = `${this.endpointBase}/v1/public/${valrPair}/trades?limit=100`;
    const res = await this.httpGet(url);
    const body = (await res.json()) as ValrTrade[];
    if (!Array.isArray(body)) {
      throw new Error("VALR: trades response not an array");
    }

    const fromMs = from.getTime();
    const toMs = to.getTime();
    const trades: Array<{ ts: number; price: number; amount: number }> = [];
    for (const t of body) {
      const ts = new Date(t.tradedAt).getTime();
      if (!isFinite(ts) || ts < fromMs || ts > toMs) continue;
      const price = Number(t.price);
      const amount = Number(t.quantity);
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
      const url = `${this.endpointBase}/v1/public/BTCZAR/marketsummary`;
      const res = await this.httpGet(url);
      const body = (await res.json()) as { lastTradedPrice?: string };
      const reachable = Number(body?.lastTradedPrice) > 0;
      return {
        name: this.name,
        reachable,
        lastSuccessAt: reachable ? new Date() : undefined,
        lastFailureAt: reachable ? undefined : new Date(),
        lastError: reachable ? undefined : "marketsummary missing lastTradedPrice",
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

interface ValrTrade {
  price: string;
  quantity: string;
  currencyPair: string;
  tradedAt: string;
  takerSide: string;
  sequenceId?: number;
  id?: string;
  quoteVolume?: string;
}
