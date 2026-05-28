/**
 * Independent Reserve source plug-in (BTC/AUD).
 *
 * Independent Reserve is an Australian-regulated (AUSTRAC, NZ FSPR) exchange
 * with deep BTC/AUD liquidity. Their public market API does not publish a
 * 1-minute candlestick endpoint, but exposes a recent-trades endpoint we
 * synthesize from.
 *
 * Public endpoint used:
 *   GET https://api.independentreserve.com/Public/GetRecentTrades
 *     ?primaryCurrencyCode=Xbt
 *     &secondaryCurrencyCode=Aud
 *     &numberOfRecentTradesToRetrieve=100
 *
 *   Response:
 *     {
 *       "Trades": [
 *         {
 *           "TradeTimestampUtc": "2026-05-26T22:34:12.6089589Z",
 *           "PrimaryCurrencyAmount": 0.00002352,
 *           "SecondaryCurrencyTradePrice": 105742.78,
 *           "TradeGuid": "...",
 *           "Taker": "Bid"|"Offer"
 *         },
 *         ...
 *       ]
 *     }
 *
 * Currency-code mapping:
 *   - BTC → "Xbt"
 *   - AUD → "Aud" (home market, deepest liquidity)
 *   - SGD → "Sgd" (Singapore — enabled 2026-05-27, verified live trades)
 *   - NZD → "Nzd" (New Zealand — enabled 2026-05-27, verified live trades)
 *   - USD → "Usd" (supported by the venue but not enabled here; the BTC/USD
 *     basket already has Tier A coverage from Kraken/Bitstamp/Coinbase/Bitfinex).
 *
 * Per-source posture:
 *   - rate limit: Independent Reserve documents "do not exceed 1 request per
 *     second" on public endpoints; we use 1 rps.
 *   - free, no auth required for /Public/* endpoints.
 *   - tier: primary.
 *
 * Validated empirically 2026-05-26: returns 100 trades, most-recent-first,
 * with sub-second timestamps suitable for 1-minute bucketing.
 *
 * See https://www.independentreserve.com/products/api for endpoint reference.
 */

import { BaseSource, type BaseSourceConfig } from "./base.ts";
import { aggregateTradesToCandles } from "./trades-aggregation.ts";
import type { Candle, HealthStatus, Pair } from "./types.ts";

const PAIR_MAP: Record<string, { primary: string; secondary: string }> = {
  "BTC-AUD": { primary: "Xbt", secondary: "Aud" },
  "BTC-SGD": { primary: "Xbt", secondary: "Sgd" },
  "BTC-NZD": { primary: "Xbt", secondary: "Nzd" },
};

export class IndependentReserveSource extends BaseSource {
  constructor() {
    const cfg: BaseSourceConfig = {
      name: "independent_reserve",
      role: "primary",
      endpointBase: "https://api.independentreserve.com",
      userAgent:
        "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)",
      rateLimitRps: 1.0,
      pairsSupported: Object.keys(PAIR_MAP),
    };
    super(cfg);
  }

  protected async fetchCandles(pair: Pair, from: Date, to: Date): Promise<Candle[]> {
    const ourPair = `${pair.source}-${pair.target}`;
    const codes = PAIR_MAP[ourPair];
    if (!codes) {
      throw new Error(`Independent Reserve: unsupported pair ${ourPair}`);
    }

    const url =
      `${this.endpointBase}/Public/GetRecentTrades` +
      `?primaryCurrencyCode=${codes.primary}` +
      `&secondaryCurrencyCode=${codes.secondary}` +
      // Independent Reserve caps numberOfRecentTradesToRetrieve at 50
      // (HTTP 400 ValidationError above that). Validated 2026-05-26.
      `&numberOfRecentTradesToRetrieve=50`;

    const res = await this.httpGet(url);
    const body = (await res.json()) as IRTradesResponse;
    if (!Array.isArray(body.Trades)) {
      throw new Error("Independent Reserve: response missing Trades array");
    }

    const fromMs = from.getTime();
    const toMs = to.getTime();
    const trades: Array<{ ts: number; price: number; amount: number }> = [];
    for (const t of body.Trades) {
      const ts = new Date(t.TradeTimestampUtc).getTime();
      if (!isFinite(ts) || ts < fromMs || ts > toMs) continue;
      const price = Number(t.SecondaryCurrencyTradePrice);
      const amount = Number(t.PrimaryCurrencyAmount);
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
      const url =
        `${this.endpointBase}/Public/GetMarketSummary` +
        `?primaryCurrencyCode=Xbt&secondaryCurrencyCode=Aud`;
      const res = await this.httpGet(url);
      const body = (await res.json()) as { LastPrice?: number };
      const reachable = typeof body?.LastPrice === "number" && body.LastPrice > 0;
      return {
        name: this.name,
        reachable,
        lastSuccessAt: reachable ? new Date() : undefined,
        lastFailureAt: reachable ? undefined : new Date(),
        lastError: reachable ? undefined : "market summary missing LastPrice",
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

interface IRTradesResponse {
  Trades: Array<{
    TradeTimestampUtc: string;
    PrimaryCurrencyAmount: number;
    SecondaryCurrencyTradePrice: number;
    TradeGuid: string;
    Taker: string;
  }>;
}
