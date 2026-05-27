/**
 * Bitfinex source plug-in.
 *
 * Endpoint: GET https://api-pub.bitfinex.com/v2/candles/trade:{tf}:{symbol}/hist
 *   ?start=unix_ms&end=unix_ms&limit=N&sort=1
 *
 * Response: array of [mts, open, close, high, low, volume]
 *   ⚠️ ORDER IS [mts, open, CLOSE, HIGH, LOW, volume] — close comes before high/low,
 *   unlike most exchanges. Easy bug if not careful.
 *
 * Per-source posture:
 *   - rate limit: 10-90 req/min varies; 60-sec IP block on breach. We use 0.33 rps
 *     (1 req per 3 sec) to stay well below the lowest threshold
 *   - ToS posture: SILENT on indexes (Bitfinex-style). NO outreach email per
 *     Hybrid Asymmetric Risk-Management Strategy
 *   - up to 10,000 candles per call — very efficient
 *
 * Pair codes: prefixed with 't' (tBTCUSD).
 */

import { BaseSource, type BaseSourceConfig } from "./base";
import type { Candle, HealthStatus, Pair } from "./types";

const PAIR_MAP: Record<string, string> = {
  "BTC-USD": "tBTCUSD",
  // Stablecoin / fiat-peg spot pairs. Bitfinex spot symbols use legacy
  // 3-letter codes for these: UST=USDT, UDC=USDC. The base IS the stablecoin
  // (peg measurement, NOT BTC priced in the stablecoin).
  "USDT-USD": "tUSTUSD",
  "USDC-USD": "tUDCUSD",
  "DAI-USD": "tDAIUSD",
};

export class BitfinexSource extends BaseSource {
  constructor() {
    const cfg: BaseSourceConfig = {
      name: "bitfinex",
      role: "primary",
      endpointBase: "https://api-pub.bitfinex.com",
      userAgent: "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)",
      rateLimitRps: 0.33,
      pairsSupported: Object.keys(PAIR_MAP),
    };
    super(cfg);
  }

  protected async fetchCandles(pair: Pair, from: Date, to: Date): Promise<Candle[]> {
    const ourPair = `${pair.source}-${pair.target}`;
    const bfxPair = PAIR_MAP[ourPair];
    if (!bfxPair) {
      throw new Error(`Bitfinex: unsupported pair ${ourPair}`);
    }

    const startMs = from.getTime();
    const endMs = to.getTime();
    // Bitfinex /candles/.../hist returns most-recent-first by default; sort=1 = ascending
    const url = `${this.endpointBase}/v2/candles/trade:1m:${bfxPair}/hist?start=${startMs}&end=${endMs}&limit=100&sort=1`;
    const res = await this.httpGet(url);
    const body = (await res.json()) as BitfinexCandleTuple[];

    if (!Array.isArray(body)) {
      throw new Error(`Bitfinex: unexpected response shape (not an array)`);
    }

    return body.map((tuple) => ({
      bucketTs: new Date(Number(tuple[0])),
      open: Number(tuple[1]),
      // CRITICAL ORDER: tuple is [mts, open, close, high, low, volume]
      close: Number(tuple[2]),
      high: Number(tuple[3]),
      low: Number(tuple[4]),
      volume: Number(tuple[5]),
    }));
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.waitForCadence();
      // /v2/platform/status returns [1] when up, [0] when in maintenance
      const url = `${this.endpointBase}/v2/platform/status`;
      const res = await this.httpGet(url);
      const body = (await res.json()) as number[];
      const reachable = Array.isArray(body) && body[0] === 1;
      return {
        name: this.name,
        reachable,
        lastSuccessAt: reachable ? new Date() : undefined,
        lastFailureAt: reachable ? undefined : new Date(),
        lastError: reachable ? undefined : `Bitfinex platform status: ${JSON.stringify(body)}`,
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

/** Bitfinex tuple: [mts, open, close, high, low, volume]. */
type BitfinexCandleTuple = [number, number, number, number, number, number];
