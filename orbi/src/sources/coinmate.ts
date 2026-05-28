/**
 * Coinmate source plug-in (BTC/CZK, BTC/EUR).
 *
 * Coinmate is a Czech-operated spot exchange (registered with the Czech
 * National Bank as a VASP). Of the keyless Central European venues we
 * surveyed, Coinmate is the only one publishing a working public market
 * REST API that exposes per-minute history without an API key.
 *
 * Public endpoints used:
 *   - GET https://coinmate.io/api/transactions?currencyPair=BTC_CZK
 *           &minutesIntoHistory=2
 *       Recent trades:
 *         { "error": false, "data": [
 *             { "timestamp": <unix-ms>, "transactionId": <int>,
 *               "price": <fiat>, "amount": <btc>, "currencyPair": "BTC_CZK",
 *               "tradeType": "BUY"|"SELL" }, ... ] }
 *   - GET https://coinmate.io/api/ticker?currencyPair=BTC_CZK (health)
 *       → { "error": false, "data": { "last": <fiat>, "high", "low",
 *           "amount", "bid", "ask", "change", "open", "timestamp",
 *           "status" } }
 *
 * Pair handling:
 *   - BTC-CZK is the value pair (the only liquid keyless CZK source).
 *   - BTC-EUR is also listed by Coinmate and is wired up here as a
 *     low-priority diversifier; the existing EUR direct sources (Kraken,
 *     Bitstamp, Bitfinex, Coinbase Exchange) cover EUR at Tier A already.
 *
 * Per-source posture:
 *   - rate limit: Coinmate documents 100 requests / 60 seconds for public
 *     endpoints (~1.7 rps); we cap to 1 rps for headroom.
 *   - free, no auth required for /api/transactions and /api/ticker.
 *   - IMPORTANT: api.coinmate.io is NOT reachable from our hosts (TCP
 *     timeout) — only coinmate.io (the apex) serves the public API. The
 *     plug-in's endpointBase reflects this empirical reality.
 *   - tier: primary.
 *
 * Validated empirically 2026-05-27 — /api/ticker reported last 1,544,401
 * CZK with status TRADING.
 *
 * See https://coinmate.docs.apiary.io/ for endpoint reference.
 */

import { BaseSource, type BaseSourceConfig } from "./base.ts";
import { aggregateTradesToCandles } from "./trades-aggregation.ts";
import type { Candle, HealthStatus, Pair } from "./types.ts";

const PAIR_MAP: Record<string, string> = {
  "BTC-CZK": "BTC_CZK",
  "BTC-EUR": "BTC_EUR",
};

export class CoinmateSource extends BaseSource {
  constructor() {
    const cfg: BaseSourceConfig = {
      name: "coinmate",
      role: "primary",
      endpointBase: "https://coinmate.io",
      userAgent:
        "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)",
      rateLimitRps: 1.0,
      pairsSupported: Object.keys(PAIR_MAP),
    };
    super(cfg);
  }

  protected async fetchCandles(pair: Pair, from: Date, to: Date): Promise<Candle[]> {
    const ourPair = `${pair.source}-${pair.target}`;
    const cmPair = PAIR_MAP[ourPair];
    if (!cmPair) {
      throw new Error(`Coinmate: unsupported pair ${ourPair}`);
    }

    // minutesIntoHistory is capped at small values; 3 covers any one-minute
    // window with 1-min slack on each side.
    const url =
      `${this.endpointBase}/api/transactions?currencyPair=${cmPair}` +
      `&minutesIntoHistory=3`;
    const res = await this.httpGet(url);
    const body = (await res.json()) as CoinmateTradesResponse;
    if (body.error || !Array.isArray(body.data)) {
      throw new Error(
        `Coinmate: trades response error=${body.error} msg=${body.errorMessage ?? ""}`,
      );
    }

    const fromMs = from.getTime();
    const toMs = to.getTime();
    const trades: Array<{ ts: number; price: number; amount: number }> = [];
    for (const row of body.data) {
      const ts = Number(row.timestamp);
      const price = Number(row.price);
      const amount = Number(row.amount);
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
      const url = `${this.endpointBase}/api/ticker?currencyPair=BTC_CZK`;
      const res = await this.httpGet(url);
      const body = (await res.json()) as CoinmateTickerResponse;
      const last = body?.data ? Number(body.data.last) : NaN;
      const reachable =
        !body?.error && isFinite(last) && last > 0 && body?.data?.status !== "HALTED";
      return {
        name: this.name,
        reachable,
        lastSuccessAt: reachable ? new Date() : undefined,
        lastFailureAt: reachable ? undefined : new Date(),
        lastError: reachable
          ? undefined
          : `ticker error=${body?.error} status=${body?.data?.status} last=${body?.data?.last}`,
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

interface CoinmateTradesResponse {
  error: boolean;
  errorMessage?: string | null;
  data?: Array<{
    timestamp: number;
    transactionId?: number;
    price: number;
    amount: number;
    currencyPair: string;
    tradeType: "BUY" | "SELL";
  }>;
}

interface CoinmateTickerResponse {
  error: boolean;
  errorMessage?: string | null;
  data?: {
    last?: number;
    high?: number;
    low?: number;
    amount?: number;
    bid?: number;
    ask?: number;
    change?: number;
    open?: number;
    timestamp?: number;
    status?: string;
  };
}
