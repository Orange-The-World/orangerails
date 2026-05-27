/**
 * Coinbase Exchange source plug-in.
 *
 * Endpoint: GET https://api.exchange.coinbase.com/products/{pair}/candles
 *   ?granularity=60&start=<ISO>&end=<ISO>
 *
 * Response shape (real Coinbase Exchange):
 *   [[time_unix_seconds, low, high, open, close, volume], ...]
 *   ORDER IS [time, low, high, open, close, volume] — low/high come BEFORE open/close,
 *   unlike most exchanges. Easy bug if not careful.
 *
 * Results are returned MOST-RECENT-FIRST.
 *
 * Per-source posture:
 *   - rate limit: ~10 req/sec public; we use 1 rps for headroom
 *   - timeout: 3 seconds per request (set by BaseSource)
 *   - exponential backoff on 429/5xx (set by BaseSource)
 *   - free, no auth required
 *   - User-Agent identifies as Orange-Rails-ORBI/1.0
 *
 * Pairs: Coinbase Exchange does NOT list BTC-CAD. Verified 2026-05-26.
 *
 * See https://docs.cdp.coinbase.com/exchange/reference/exchangerestapi_getproductcandles
 * for endpoint reference.
 */

import { BaseSource, type BaseSourceConfig } from "./base";
import type { Candle, HealthStatus, Pair } from "./types";

/** Canonicalize ORBI pair to Coinbase Exchange product id. */
const PAIR_MAP: Record<string, string> = {
  "BTC-USD": "BTC-USD",
  "BTC-EUR": "BTC-EUR",
  "BTC-GBP": "BTC-GBP",
  "BTC-INR": "BTC-INR",
  // Stablecoin / fiat-peg spot pairs. NOTE: Coinbase Exchange does NOT list
  // USDC-USD (USDC is their home stablecoin; the self-pair returns 404).
  // PYUSD-USD and EURC-EUR verified live 2026-05-27 with non-zero volume.
  "USDT-USD": "USDT-USD",
  "DAI-USD": "DAI-USD",
  "PYUSD-USD": "PYUSD-USD",
  "EURC-EUR": "EURC-EUR",
};

export class CoinbaseExchangeSource extends BaseSource {
  constructor() {
    const cfg: BaseSourceConfig = {
      name: "coinbase_exchange",
      role: "primary",
      endpointBase: "https://api.exchange.coinbase.com",
      userAgent: "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)",
      rateLimitRps: 1.0,
      pairsSupported: Object.keys(PAIR_MAP),
    };
    super(cfg);
  }

  protected async fetchCandles(pair: Pair, from: Date, to: Date): Promise<Candle[]> {
    const ourPair = `${pair.source}-${pair.target}`;
    const cbProduct = PAIR_MAP[ourPair];
    if (!cbProduct) {
      throw new Error(`Coinbase Exchange: unsupported pair ${ourPair}`);
    }

    const startIso = from.toISOString();
    const endIso = to.toISOString();
    const url =
      `${this.endpointBase}/products/${cbProduct}/candles` +
      `?granularity=60&start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`;

    const res = await this.httpGet(url);
    const body = (await res.json()) as CoinbaseCandleTuple[];

    if (!Array.isArray(body)) {
      throw new Error(`Coinbase Exchange: unexpected response shape (not an array)`);
    }

    // Tuples are [time_unix_seconds, low, high, open, close, volume]
    return body.map((tuple) => ({
      bucketTs: new Date(Number(tuple[0]) * 1000),
      // CRITICAL ORDER: tuple is [time, low, high, open, close, volume]
      low: Number(tuple[1]),
      high: Number(tuple[2]),
      open: Number(tuple[3]),
      close: Number(tuple[4]),
      volume: Number(tuple[5]),
    }));
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.waitForCadence();
      // /products/BTC-USD/ticker is cheap; returns a single quote
      const url = `${this.endpointBase}/products/BTC-USD/ticker`;
      const res = await this.httpGet(url);
      const body = (await res.json()) as CoinbaseTickerResponse;
      const reachable = typeof body?.price === "string" && Number(body.price) > 0;
      return {
        name: this.name,
        reachable,
        lastSuccessAt: reachable ? new Date() : undefined,
        lastFailureAt: reachable ? undefined : new Date(),
        lastError: reachable
          ? undefined
          : `Coinbase Exchange ticker: ${JSON.stringify(body)}`,
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

// ---- Coinbase Exchange response types ----

/** Coinbase Exchange candle tuple: [time, low, high, open, close, volume]. */
type CoinbaseCandleTuple = [number, number, number, number, number, number];

interface CoinbaseTickerResponse {
  price?: string;
  size?: string;
  time?: string;
}
