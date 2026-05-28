/**
 * Kraken source plug-in.
 *
 * Endpoint: GET https://api.kraken.com/0/public/OHLC?pair={pair}&interval={1}&since={unix}
 *
 * Response shape (real Kraken):
 *   {
 *     "error": [],
 *     "result": {
 *       "XXBTZUSD": [ [unix_ts, "open", "high", "low", "close", "vwap", "volume", count], ... ],
 *       "last": 1709234567
 *     }
 *   }
 *
 * Pair canonicalization: ORBI uses "BTC-USD"; Kraken uses "XBTUSD" (and historically
 * "XXBTZUSD" in the result key). The plug-in maps both directions.
 *
 * Per-source posture:
 *   - rate limit: 1 req/sec public limit; we use 0.5 rps (1 req every 2 seconds) for headroom
 *   - timeout: 3 seconds per request (set by BaseSource)
 *   - exponential backoff on 429/5xx (set by BaseSource)
 *   - User-Agent identifies as Orange-Rails-ORBI/1.0
 *   - written-permission email sent to Kraken institutional team Phase 0 week 1
 *
 * See https://docs.kraken.com/api/docs/rest-api/get-ohlc-data/ for endpoint reference.
 */

import { BaseSource, type BaseSourceConfig } from "./base.ts";
import type { Candle, HealthStatus, Pair } from "./types.ts";

/** Canonicalize ORBI pair → Kraken pair. */
const PAIR_MAP: Record<string, string> = {
  "BTC-USD": "XBTUSD",
  "BTC-EUR": "XBTEUR",
  "BTC-GBP": "XBTGBP",
  "BTC-CAD": "XBTCAD",
  "BTC-AUD": "XBTAUD",
  "BTC-JPY": "XBTJPY",
  "BTC-CHF": "XBTCHF",
  // Stablecoin / fiat-peg spot pairs. The base IS the stablecoin (we are
  // measuring the peg, NOT the BTC price denominated in the stablecoin).
  "USDT-USD": "USDTUSD",
  "USDC-USD": "USDCUSD",
  "DAI-USD": "DAIUSD",
  "PYUSD-USD": "PYUSDUSD",
  // Circle EURC: Kraken's canonical pair code is EURCEUR (verified live
  // 2026-05-27 via /AssetPairs). The altname EUROCEUR appears in some
  // older docs but /OHLC rejects it with "Invalid asset pair".
  "EURC-EUR": "EURCEUR",
};

/** Kraken returns some pairs with X-prefixed legacy codes in the result keys. */
const RESULT_KEY_ALIASES: Record<string, string[]> = {
  XBTUSD: ["XXBTZUSD", "XBTUSD"],
  XBTEUR: ["XXBTZEUR", "XBTEUR"],
  XBTGBP: ["XXBTZGBP", "XBTGBP"],
  XBTCAD: ["XBTCAD"],
  XBTAUD: ["XBTAUD"],
  XBTJPY: ["XXBTZJPY", "XBTJPY"],
  XBTCHF: ["XBTCHF"],
  // Kraken returns USDT/USD under the legacy Z-prefixed result key.
  USDTUSD: ["USDTZUSD", "USDTUSD"],
  // EURCEUR is both the request and result key.
  EURCEUR: ["EURCEUR"],
};

export class KrakenSource extends BaseSource {
  constructor() {
    const cfg: BaseSourceConfig = {
      name: "kraken",
      role: "primary",
      endpointBase: "https://api.kraken.com",
      userAgent: "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)",
      rateLimitRps: 0.5,
      pairsSupported: Object.keys(PAIR_MAP),
    };
    super(cfg);
  }

  protected async fetchCandles(pair: Pair, from: Date, to: Date): Promise<Candle[]> {
    const ourPair = `${pair.source}-${pair.target}`;
    const krakenPair = PAIR_MAP[ourPair];
    if (!krakenPair) {
      throw new Error(`Kraken: unsupported pair ${ourPair}`);
    }

    // Kraken's `since` is unix timestamp seconds; returns candles AFTER that point, up to 720 candles
    const sinceSec = Math.floor(from.getTime() / 1000);
    const url = `${this.endpointBase}/0/public/OHLC?pair=${krakenPair}&interval=1&since=${sinceSec}`;
    const res = await this.httpGet(url);
    const body = (await res.json()) as KrakenOhlcResponse;

    if (Array.isArray(body.error) && body.error.length > 0) {
      throw new Error(`Kraken API error: ${body.error.join("; ")}`);
    }

    const candidateKeys = RESULT_KEY_ALIASES[krakenPair] ?? [krakenPair];
    let rawCandles: KrakenCandleTuple[] | undefined;
    for (const k of candidateKeys) {
      const found = body.result?.[k];
      if (Array.isArray(found)) {
        rawCandles = found as KrakenCandleTuple[];
        break;
      }
    }
    if (!rawCandles) {
      throw new Error(`Kraken: no candles found in result for ${krakenPair}; got keys ${Object.keys(body.result ?? {}).join(",")}`);
    }

    const toMs = to.getTime();
    const candles: Candle[] = [];
    for (const tuple of rawCandles) {
      const bucketTs = new Date(Number(tuple[0]) * 1000);
      if (bucketTs.getTime() > toMs) continue;
      candles.push({
        bucketTs,
        open: Number(tuple[1]),
        high: Number(tuple[2]),
        low: Number(tuple[3]),
        close: Number(tuple[4]),
        // tuple[5] is Kraken's own VWAP (not used)
        volume: Number(tuple[6]),
        // tuple[7] is trade count (not stored)
      });
    }
    return candles;
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.waitForCadence();
      const url = `${this.endpointBase}/0/public/SystemStatus`;
      const res = await this.httpGet(url);
      const body = (await res.json()) as KrakenSystemStatusResponse;
      const operational = body.result?.status === "online";
      return {
        name: this.name,
        reachable: operational,
        lastSuccessAt: operational ? new Date() : undefined,
        lastFailureAt: operational ? undefined : new Date(),
        lastError: operational ? undefined : `Kraken status: ${body.result?.status}`,
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

// ---- Kraken response types ----

/** Kraken OHLC tuple: [time, open, high, low, close, vwap, volume, count]. */
type KrakenCandleTuple = [number, string, string, string, string, string, string, number];

interface KrakenOhlcResponse {
  error: string[];
  result: Record<string, unknown> & { last?: number };
}

interface KrakenSystemStatusResponse {
  error: string[];
  result?: {
    status?: string;
    timestamp?: string;
  };
}
