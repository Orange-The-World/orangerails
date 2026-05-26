/**
 * Bitso source plug-in.
 *
 * IMPORTANT: Bitso does NOT publish an official OHLC/candles endpoint.
 * The plug-in pulls /v3/trades/ (documented public endpoint) and aggregates
 * trade ticks into 1-minute OHLC bars in code.
 *
 * Endpoint: GET https://api.bitso.com/v3/trades/?book={book}&limit=N&marker=N&sort=desc
 *
 * Response shape:
 *   {
 *     "success": true,
 *     "payload": [
 *       {"book":"btc_mxn","created_at":"2026-05-26T03:35:11+00:00","amount":"0.123",
 *        "maker_side":"sell","price":"1234567.89","tid":123456789},
 *       ...
 *     ]
 *   }
 *
 * Trade-to-OHLC aggregation:
 *   - Group trades by floor(timestamp / 60s)
 *   - For each bucket: open=earliest, close=latest, high=max, low=min, volume=sum(amount)
 *
 * Per-source posture:
 *   - rate limit: 60 req/min public (1 rps). HTTP 420 on breach, 1-min lockout
 *   - ToS posture SILENT on indexes (Bitfinex-style)
 *   - Courtesy email to api@bitso.com (paper trail, does NOT gate launch)
 *   - Bitso already partners with Kaiko, so their data flows into commercial
 *     indexes upstream — strong implicit signal we're fine
 *
 * Pair codes: lowercased with underscore separator (btc_mxn, btc_brl, btc_ars).
 */

import { BaseSource, type BaseSourceConfig } from "./base";
import type { Candle, HealthStatus, Pair } from "./types";

const PAIR_MAP: Record<string, string> = {
  "BTC-MXN": "btc_mxn",
  "BTC-BRL": "btc_brl",
  "BTC-ARS": "btc_ars",
  "BTC-USD": "btc_usd",
  "BTC-USDT": "btc_usdt",
};

export class BitsoSource extends BaseSource {
  constructor() {
    const cfg: BaseSourceConfig = {
      name: "bitso",
      role: "primary",
      endpointBase: "https://api.bitso.com",
      userAgent: "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)",
      rateLimitRps: 1.0,
      pairsSupported: Object.keys(PAIR_MAP),
    };
    super(cfg);
  }

  protected async fetchCandles(pair: Pair, from: Date, to: Date): Promise<Candle[]> {
    const ourPair = `${pair.source}-${pair.target}`;
    const bitsoBook = PAIR_MAP[ourPair];
    if (!bitsoBook) {
      throw new Error(`Bitso: unsupported pair ${ourPair}`);
    }

    // Bitso /trades returns most-recent-first. We pull up to 100 trades and
    // filter to our window. For a 1-2 minute window this is plenty.
    const url = `${this.endpointBase}/v3/trades/?book=${bitsoBook}&limit=100&sort=desc`;
    const res = await this.httpGet(url);
    const body = (await res.json()) as BitsoTradesResponse;

    if (!body.success || !Array.isArray(body.payload)) {
      throw new Error(`Bitso: API error or unexpected response shape`);
    }

    const fromMs = from.getTime();
    const toMs = to.getTime();

    // Parse and filter trades into our window
    const trades: Array<{ ts: number; price: number; amount: number }> = [];
    for (const t of body.payload) {
      const ts = new Date(t.created_at).getTime();
      if (ts < fromMs || ts > toMs) continue;
      const price = Number(t.price);
      const amount = Number(t.amount);
      if (!isFinite(price) || price <= 0 || !isFinite(amount) || amount <= 0) continue;
      trades.push({ ts, price, amount });
    }

    if (trades.length === 0) {
      return [];
    }

    // Sort ascending by timestamp for aggregation
    trades.sort((a, b) => a.ts - b.ts);

    return aggregateTradesToCandles(trades);
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.waitForCadence();
      // /v3/available_books/ is a cheap public endpoint
      const url = `${this.endpointBase}/v3/available_books/`;
      const res = await this.httpGet(url);
      const body = (await res.json()) as { success?: boolean };
      const reachable = body.success === true;
      return {
        name: this.name,
        reachable,
        lastSuccessAt: reachable ? new Date() : undefined,
        lastFailureAt: reachable ? undefined : new Date(),
        lastError: reachable ? undefined : "available_books returned non-success",
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

/**
 * Aggregate a sorted list of (timestamp, price, amount) trades into 1-minute OHLC.
 * Exported for testing the aggregation logic independently.
 */
export function aggregateTradesToCandles(
  trades: ReadonlyArray<{ ts: number; price: number; amount: number }>,
): Candle[] {
  if (trades.length === 0) return [];

  // Group by 1-minute bucket
  const byBucket = new Map<number, Array<{ ts: number; price: number; amount: number }>>();
  for (const t of trades) {
    const bucketMs = Math.floor(t.ts / 60_000) * 60_000;
    let bucket = byBucket.get(bucketMs);
    if (!bucket) {
      bucket = [];
      byBucket.set(bucketMs, bucket);
    }
    bucket.push(t);
  }

  const candles: Candle[] = [];
  for (const [bucketMs, bucketTrades] of byBucket) {
    bucketTrades.sort((a, b) => a.ts - b.ts);
    let open = bucketTrades[0]!.price;
    let close = bucketTrades[bucketTrades.length - 1]!.price;
    let high = bucketTrades[0]!.price;
    let low = bucketTrades[0]!.price;
    let volume = 0;
    for (const t of bucketTrades) {
      if (t.price > high) high = t.price;
      if (t.price < low) low = t.price;
      volume += t.amount;
    }
    candles.push({
      bucketTs: new Date(bucketMs),
      open,
      high,
      low,
      close,
      volume,
    });
  }

  candles.sort((a, b) => a.bucketTs.getTime() - b.bucketTs.getTime());
  return candles;
}

interface BitsoTradesResponse {
  success?: boolean;
  payload?: Array<{
    book: string;
    created_at: string;
    amount: string;
    maker_side: string;
    price: string;
    tid: number;
  }>;
}
