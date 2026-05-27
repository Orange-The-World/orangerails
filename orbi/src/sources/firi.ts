/**
 * Firi source plug-in (BTC/NOK, BTC/DKK).
 *
 * Firi (formerly MiraiEx) is a Finanstilsynet-registered Norwegian exchange
 * with the only liquid Nordic BTC/fiat order book that publishes a keyless
 * public market API. They list BTC against NOK and DKK directly; SEK is
 * NOT listed by Firi (verified 2026-05-27, /v2/markets/BTCSEK → AssetNotFound).
 *
 * Endpoint: GET https://api.firi.com/v2/markets/{marketId}/history
 *   Response: most-recent-first array of fills:
 *     [ { "type": "bid"|"ask", "amount": "<btc>", "price": "<fiat>",
 *         "created_at": "<ISO-8601 UTC>", "total": "<fiat>" }, ... ]
 *
 *   The "type" labels the taker side; from an OHLC perspective each entry
 *   is a real fill suitable for bucketed aggregation. Confirmed by reconciling
 *   the most-recent ticker (`/v2/markets/{marketId}/ticker`) against the
 *   most-recent history row on 2026-05-27.
 *
 * Health endpoint:
 *   GET https://api.firi.com/v2/markets/{marketId} → { last, high, low, ... }
 *
 * Pair coverage enabled here:
 *   - BTC-NOK: validated 2026-05-27 (last 698060 NOK, 24h vol 4.41 BTC).
 *   - BTC-DKK: validated 2026-05-27 (last 490367 DKK; volume is thin, the
 *     pair earns its keep during stress windows where ECB cross-rates lag).
 *
 * Per-source posture:
 *   - rate limit: Firi does not document a hard public limit; we conservatively
 *     cap to 1 rps (their site front-end polls at roughly that cadence).
 *   - free, no auth required for /v2/markets/* public endpoints.
 *   - tier: primary.
 *
 * BTC/SEK is intentionally absent (Firi does not list it). BTC/SEK is wired
 * up as a composite-only pair via BTC/USD ORBI × USD/SEK Frankfurter.
 *
 * See https://developers.firi.com for endpoint reference.
 */

import { BaseSource, type BaseSourceConfig } from "./base";
import { aggregateTradesToCandles } from "./trades-aggregation";
import type { Candle, HealthStatus, Pair } from "./types";

const PAIR_MAP: Record<string, string> = {
  "BTC-NOK": "BTCNOK",
  "BTC-DKK": "BTCDKK",
};

export class FiriSource extends BaseSource {
  constructor() {
    const cfg: BaseSourceConfig = {
      name: "firi",
      role: "primary",
      endpointBase: "https://api.firi.com",
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
      throw new Error(`Firi: unsupported pair ${ourPair}`);
    }

    // /history returns the most-recent fills, no time-window query param.
    // Volume on the Nordic pairs is thin enough that "most recent N" comfortably
    // covers a 1-2 minute window; we filter to [from, to] locally.
    const url = `${this.endpointBase}/v2/markets/${marketId}/history`;
    const res = await this.httpGet(url);
    const body = (await res.json()) as FiriHistoryRow[];
    if (!Array.isArray(body)) {
      throw new Error(`Firi: history response not an array for ${marketId}`);
    }

    const fromMs = from.getTime();
    const toMs = to.getTime();
    const trades: Array<{ ts: number; price: number; amount: number }> = [];
    for (const row of body) {
      const ts = new Date(row.created_at).getTime();
      if (!isFinite(ts) || ts < fromMs || ts > toMs) continue;
      const price = Number(row.price);
      const amount = Number(row.amount);
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
      const url = `${this.endpointBase}/v2/markets/BTCNOK`;
      const res = await this.httpGet(url);
      const body = (await res.json()) as { last?: string | number };
      const last = body?.last !== undefined ? Number(body.last) : NaN;
      const reachable = isFinite(last) && last > 0;
      return {
        name: this.name,
        reachable,
        lastSuccessAt: reachable ? new Date() : undefined,
        lastFailureAt: reachable ? undefined : new Date(),
        lastError: reachable ? undefined : "Firi market summary missing `last`",
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

interface FiriHistoryRow {
  type: string;
  amount: string;
  price: string;
  created_at: string;
  total?: string;
}
