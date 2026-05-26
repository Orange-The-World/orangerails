/**
 * Bitfinex paged-API historical-backfill source — Phase B.4.
 *
 * Endpoint:
 *   GET https://api-pub.bitfinex.com/v2/candles/trade:1m:t{PAIR}/hist
 *     ?start=<ms>&end=<ms>&limit=10000&sort=1
 *
 * Response: array of tuples
 *   [ [mts, open, close, high, low, volume], ... ]
 *
 *   CRITICAL: Bitfinex orders the tuple as [mts, OPEN, CLOSE, HIGH, LOW,
 *   VOLUME] — close before high/low. Same shape as the live `bitfinex.ts`
 *   source plug-in already handles. Easy bug if you assume OHLC.
 *
 * Pagination:
 *   - `limit=10000` is the documented hard cap (10000 candles per call).
 *   - `sort=1` returns ascending by timestamp. We take the last returned
 *     `mts`, set next `start = lastMts + 60_000`, repeat until either an
 *     empty array or `lastMts >= end` is observed.
 *
 * Depth available: tBTCUSD goes back to 2013-04-01; tBTCEUR to 2019-06;
 * tBTCGBP to 2018-11. Sparse pre-2013 minutes are absent (the orchestrator
 * drops candles outside [from, to)).
 *
 * Rate limit: 30 req/min on the public unauthenticated /v2 endpoints; the
 * platform issues a 60-second IP block on breach. Default = 0.4 rps
 * (24 rpm) to stay below the cap with headroom for retries.
 *
 * Auth: none required for /api-pub endpoints.
 *
 * Output: yields `Candle` with `volume` in base asset (BTC) — matches our
 * Candle contract.
 */

import { RateLimiter } from "../lib/rate-limiter";
import type { Candle } from "../../../src/sources/types";

export type BitfinexPagedPair = "BTC/USD" | "BTC/EUR" | "BTC/GBP";

const PAIR_TO_BITFINEX: Record<BitfinexPagedPair, string> = {
  "BTC/USD": "tBTCUSD",
  "BTC/EUR": "tBTCEUR",
  "BTC/GBP": "tBTCGBP",
};

const ENDPOINT_BASE = "https://api-pub.bitfinex.com";
const USER_AGENT = "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)";
const PAGE_LIMIT = 10_000;
const STEP_MS = 60_000;

/** Raw tuple shape Bitfinex returns. */
export type BitfinexCandleTuple = [number, number, number, number, number, number];

export interface BitfinexPagedDeps {
  fetchFn?: typeof fetch;
  rateLimiter?: RateLimiter;
}

export class BitfinexPagedApiSource {
  static readonly name = "bitfinex-paged";
  static readonly supportedPairs: ReadonlyArray<BitfinexPagedPair> = [
    "BTC/USD",
    "BTC/EUR",
    "BTC/GBP",
  ];

  private readonly fetchFn: typeof fetch;
  private readonly rateLimiter: RateLimiter;

  constructor(deps: BitfinexPagedDeps = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.rateLimiter = deps.rateLimiter ?? new RateLimiter({ ratePerSec: 0.4, burst: 2 });
  }

  isSupported(pair: string): pair is BitfinexPagedPair {
    return (BitfinexPagedApiSource.supportedPairs as ReadonlyArray<string>).includes(pair);
  }

  bitfinexSymbol(pair: BitfinexPagedPair): string {
    return PAIR_TO_BITFINEX[pair];
  }

  urlFor(pair: BitfinexPagedPair, startMs: number, endMs: number, limit: number = PAGE_LIMIT): string {
    const sym = PAIR_TO_BITFINEX[pair];
    return `${ENDPOINT_BASE}/v2/candles/trade:1m:${sym}/hist?start=${startMs}&end=${endMs}&limit=${limit}&sort=1`;
  }

  async *fetch(
    pair: BitfinexPagedPair,
    fromTs: Date,
    toTs: Date,
  ): AsyncIterable<Candle> {
    if (!this.isSupported(pair)) {
      throw new Error(`BitfinexPagedApiSource: unsupported pair ${pair}`);
    }
    if (fromTs >= toTs) return;

    const endMs = toTs.getTime();
    let startMs = fromTs.getTime();
    const seenMs = new Set<number>();
    let pages = 0;

    while (startMs < endMs) {
      if (pages++ > 100_000) {
        throw new Error(`BitfinexPagedApiSource.fetch: page cap exceeded for ${pair} ${fromTs.toISOString()}→${toTs.toISOString()}`);
      }
      await this.rateLimiter.acquire();
      const url = this.urlFor(pair, startMs, endMs);
      const res = await this.fetchFn(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`BitfinexPagedApiSource.fetch: HTTP ${res.status} from ${url}`);
      }
      const body = (await res.json()) as BitfinexCandleTuple[] | { error?: string };
      if (!Array.isArray(body)) {
        // Bitfinex error response shape: ["error", code, msg] — also handled.
        const errStr = JSON.stringify(body).slice(0, 200);
        throw new Error(`BitfinexPagedApiSource.fetch: non-array response: ${errStr}`);
      }
      if (body.length === 0) {
        return; // no more candles in this range
      }

      let maxMs = -1;
      for (const tuple of body) {
        if (!Array.isArray(tuple) || tuple.length < 6) continue;
        const mts = Number(tuple[0]);
        if (!Number.isFinite(mts) || mts <= 0) continue;
        if (mts >= endMs) {
          maxMs = Math.max(maxMs, mts);
          continue;
        }
        if (seenMs.has(mts)) continue;
        seenMs.add(mts);
        if (mts > maxMs) maxMs = mts;

        // Tuple order: [mts, OPEN, CLOSE, HIGH, LOW, VOLUME]
        const open = Number(tuple[1]);
        const close = Number(tuple[2]);
        const high = Number(tuple[3]);
        const low = Number(tuple[4]);
        const volume = Number(tuple[5]);
        if (![open, high, low, close, volume].every(Number.isFinite)) continue;
        if (open <= 0 || high <= 0 || low <= 0 || close <= 0) continue;

        yield { bucketTs: new Date(mts), open, high, low, close, volume };
      }

      if (maxMs < 0) {
        // No usable tuples; bump one minute and continue rather than spin.
        startMs += STEP_MS;
        continue;
      }
      const nextStart = maxMs + STEP_MS;
      if (nextStart <= startMs) {
        startMs += STEP_MS;
      } else {
        startMs = nextStart;
      }
      // Note: we intentionally do NOT bail on `body.length < PAGE_LIMIT`.
      // Bitfinex sometimes returns short pages mid-history (e.g. low-volume
      // minute clusters); the only safe terminator is an empty response.
    }
  }
}
