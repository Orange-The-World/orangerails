/**
 * Coincheck source plug-in (BTC/JPY).
 *
 * Coincheck is one of Japan's largest JFSA-licensed exchanges (operated by
 * Monex Group). Their public market API does NOT expose an official OHLC
 * endpoint — we synthesize 1-minute OHLC bars from the public /api/trades
 * feed, mirroring the Bitso approach.
 *
 * Public endpoints used:
 *   - GET https://coincheck.com/api/trades?pair=btc_jpy&limit=N
 *       Recent trades, most-recent-first. Each trade has
 *       {id, amount, rate, pair, order_type, created_at}.
 *   - GET https://coincheck.com/api/ticker?pair=btc_jpy   (health check)
 *
 * Pair handling:
 *   - Only BTC-JPY is supported by this plug-in (Coincheck quotes other
 *     pairs but ORBI's JPY-direct upgrade is the value here).
 *
 * Per-source posture:
 *   - rate limit: Coincheck documents "moderate" public limits, no published
 *     RPS. We use 1 rps for headroom.
 *   - free, no auth required for public endpoints.
 *   - User-Agent identifies as Orange-Rails-ORBI/1.0
 *   - tier: primary (eligible for Tier A voting once activated).
 *
 * Validated empirically 2026-05-26: /api/trades returns array (most recent
 * first); /api/ticker returns last/bid/ask/high/low/volume/timestamp.
 *
 * See https://coincheck.com/documents/exchange/api for endpoint reference.
 */

import { BaseSource, type BaseSourceConfig } from "./base.ts";
import { aggregateTradesToCandles } from "./trades-aggregation.ts";
import type { Candle, HealthStatus, Pair } from "./types.ts";

const PAIR_MAP: Record<string, string> = {
  "BTC-JPY": "btc_jpy",
};

export class CoincheckSource extends BaseSource {
  constructor() {
    const cfg: BaseSourceConfig = {
      name: "coincheck",
      role: "primary",
      endpointBase: "https://coincheck.com",
      userAgent:
        "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)",
      rateLimitRps: 1.0,
      pairsSupported: Object.keys(PAIR_MAP),
    };
    super(cfg);
  }

  protected async fetchCandles(pair: Pair, from: Date, to: Date): Promise<Candle[]> {
    const ourPair = `${pair.source}-${pair.target}`;
    const ccPair = PAIR_MAP[ourPair];
    if (!ccPair) {
      throw new Error(`Coincheck: unsupported pair ${ourPair}`);
    }

    // Pull last 100 trades (most-recent-first); filter into window.
    const url = `${this.endpointBase}/api/trades?pair=${ccPair}&limit=100`;
    const res = await this.httpGet(url);
    const body = (await res.json()) as CoincheckTradesResponse;

    // Coincheck wraps trades in {success, data, pagination} OR returns a bare
    // array depending on endpoint version. Handle both.
    const raw: CoincheckTrade[] | undefined = Array.isArray(body)
      ? (body as CoincheckTrade[])
      : Array.isArray(body?.data)
        ? body.data
        : undefined;
    if (!raw) {
      throw new Error("Coincheck: trades response missing data array");
    }

    const fromMs = from.getTime();
    const toMs = to.getTime();

    const trades: Array<{ ts: number; price: number; amount: number }> = [];
    for (const t of raw) {
      const ts = new Date(t.created_at).getTime();
      if (!isFinite(ts) || ts < fromMs || ts > toMs) continue;
      const price = Number(t.rate);
      const amount = Number(t.amount);
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
      const url = `${this.endpointBase}/api/ticker?pair=btc_jpy`;
      const res = await this.httpGet(url);
      const body = (await res.json()) as { last?: number };
      const reachable = typeof body?.last === "number" && body.last > 0;
      return {
        name: this.name,
        reachable,
        lastSuccessAt: reachable ? new Date() : undefined,
        lastFailureAt: reachable ? undefined : new Date(),
        lastError: reachable ? undefined : "ticker missing `last` field",
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

interface CoincheckTrade {
  id: number;
  amount: string;
  rate: string;
  pair: string;
  order_type: string;
  created_at: string;
}

interface CoincheckTradesResponse {
  success?: boolean;
  data?: CoincheckTrade[];
  pagination?: unknown;
}
