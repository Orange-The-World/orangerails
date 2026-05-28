/**
 * Buda source plug-in (BTC/CLP, BTC/COP, BTC/PEN).
 *
 * Buda.com (formerly SurBTC) is a Chilean-headquartered LatAm exchange
 * operating regulated subsidiaries in Chile, Colombia, and Peru. It is
 * the only keyless venue we located that lists BTC/CLP, BTC/COP, and
 * BTC/PEN simultaneously with a single uniform public-market REST API.
 *
 * Public endpoints used:
 *   - GET https://www.buda.com/api/v2/markets/BTC-{CCY}/trades
 *       → { "trades": { "market_id", "timestamp", "last_timestamp",
 *           "entries": [
 *             [ <unix-ms-string>, <amount-btc-string>,
 *               <price-fiat-string>, <"buy"|"sell">, <trade-id> ],
 *             ...
 *           ] } }
 *       Most-recent first, ~200 entries.
 *   - GET https://www.buda.com/api/v2/markets/BTC-{CCY}/ticker (health)
 *       → { "ticker": { "market_id", "last_price": ["<fiat>", "<ccy>"],
 *           "volume": ["<btc>", "BTC"], ... } }
 *
 * Pair coverage enabled here:
 *   - BTC-CLP: validated 2026-05-27 (last 66,102,000 CLP, 2.17 BTC 24h vol —
 *     comfortably the deepest of the three; B-single most minutes).
 *   - BTC-COP: validated 2026-05-27 (last 270,001,000 COP, ~0.04 BTC 24h vol —
 *     thin; expect frequent empty-window fetches, composite fallback covers).
 *   - BTC-PEN: validated 2026-05-27 (last 254,000 PEN, ~0.08 BTC 24h vol —
 *     thin; B-single-eligible during active periods, composite otherwise).
 *
 * Per-source posture:
 *   - rate limit: Buda does not publish a hard public limit; we cap to 1 rps.
 *     Their dashboards poll the public endpoints at a similar cadence.
 *   - free, no auth required for /api/v2/markets/{id}/trades and /ticker.
 *   - tier: primary (B-single-eligible-only for COP and PEN; CLP may reach
 *     A once a second CLP source is added).
 *
 * See https://api.buda.com for endpoint reference.
 */

import { BaseSource, type BaseSourceConfig } from "./base.ts";
import { aggregateTradesToCandles } from "./trades-aggregation.ts";
import type { Candle, HealthStatus, Pair } from "./types.ts";

const PAIR_MAP: Record<string, string> = {
  "BTC-CLP": "BTC-CLP",
  "BTC-COP": "BTC-COP",
  "BTC-PEN": "BTC-PEN",
};

export class BudaSource extends BaseSource {
  constructor() {
    const cfg: BaseSourceConfig = {
      name: "buda",
      role: "primary",
      endpointBase: "https://www.buda.com",
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
      throw new Error(`Buda: unsupported pair ${ourPair}`);
    }

    const url = `${this.endpointBase}/api/v2/markets/${marketId}/trades`;
    const res = await this.httpGet(url);
    const body = (await res.json()) as BudaTradesResponse;
    const entries = body?.trades?.entries;
    if (!Array.isArray(entries)) {
      throw new Error(`Buda: trades response missing entries array for ${marketId}`);
    }

    const fromMs = from.getTime();
    const toMs = to.getTime();
    const trades: Array<{ ts: number; price: number; amount: number }> = [];
    for (const row of entries) {
      if (!Array.isArray(row) || row.length < 3) continue;
      const ts = Number(row[0]); // unix-ms as string
      const amount = Number(row[1]);
      const price = Number(row[2]);
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
      const url = `${this.endpointBase}/api/v2/markets/BTC-CLP/ticker`;
      const res = await this.httpGet(url);
      const body = (await res.json()) as BudaTickerResponse;
      const lastTuple = body?.ticker?.last_price;
      const last = Array.isArray(lastTuple) ? Number(lastTuple[0]) : NaN;
      const reachable = isFinite(last) && last > 0;
      return {
        name: this.name,
        reachable,
        lastSuccessAt: reachable ? new Date() : undefined,
        lastFailureAt: reachable ? undefined : new Date(),
        lastError: reachable ? undefined : "Buda ticker missing/invalid last_price",
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

interface BudaTradesResponse {
  trades?: {
    market_id?: string;
    timestamp?: string | null;
    last_timestamp?: string | null;
    entries?: Array<[string, string, string, string, number]>;
  };
}

interface BudaTickerResponse {
  ticker?: {
    market_id?: string;
    last_price?: [string, string];
    min_ask?: [string, string];
    max_bid?: [string, string];
    volume?: [string, string];
    quote_volume?: [string, string];
  };
}
