/**
 * Bitso paged-API historical-backfill source — Phase B.3.
 *
 * Endpoint:
 *   GET https://api.bitso.com/v3/ohlc?book={book}&time_bucket=60&start=<ms>&end=<ms>
 *
 *   IMPORTANT: Bitso uses **milliseconds** for start/end despite `time_bucket`
 *   being in seconds. Verified 2026-05-26: passing unix-seconds returns an
 *   empty payload (no error). Passing ms returns rows.
 *
 * Response shape:
 *   {
 *     "success": true,
 *     "payload": [
 *       {
 *         "bucket_start_time": 1747699200000,
 *         "first_trade_time": 1747699196329,
 *         "last_trade_time":  1747699199001,
 *         "first_rate": "2042350",
 *         "last_rate":  "2042350",
 *         "min_rate":   "2042350",
 *         "max_rate":   "2042350",
 *         "trade_count": 0,
 *         "volume":      "0",
 *         "vwap":        "0"
 *       },
 *       ...   // ascending by bucket_start_time
 *     ]
 *   }
 *
 *   We map Bitso → ORBI Candle as:
 *     bucketTs = new Date(bucket_start_time)
 *     open     = Number(first_rate)
 *     high     = Number(max_rate)
 *     low      = Number(min_rate)
 *     close    = Number(last_rate)
 *     volume   = Number(volume)        // base-asset (BTC) volume
 *
 *   Zero-trade buckets (`trade_count=0`, `volume="0"`) still report a
 *   first/last/min/max rate equal to the prior tick — Bitso's "carry the
 *   last quote" behavior. Those are emitted with volume=0; the ORBI median
 *   layer already drops zero-volume bars when combining sources.
 *
 * Pairs supported:
 *   - btc_mxn   (Mexico — flagship)
 *   - btc_ars   (Argentina — critical LATAM coverage, no other panel source)
 *   - btc_usd   (Bitso USD stablecoin-bridge book)
 *   - btc_brl   (LISTED at the time of writing but Bitso announced winding
 *               down BRL desk; we keep it in `supportedPairs` and let the
 *               dry-run smoke surface "0 rows" if it's gone).
 *
 * Depth available: Bitso OHLC depth varies per book — BTC/MXN goes back to
 * ~2014; BTC/ARS launched ~2021. The endpoint silently returns empty for
 * pre-launch windows.
 *
 * Pagination: Bitso doesn't publish a documented page-size cap on /v3/ohlc;
 * empirically it returns up to one day of 1-minute buckets per call
 * (~1440 rows). We walk in 24h windows, advance by the last returned
 * `bucket_start_time + 60_000`, and terminate on empty payload.
 *
 * Rate limit: 60 req/min for public endpoints (1 rps). HTTP 420 on breach,
 * 60-second IP lockout. Default = 0.8 rps with burst 2.
 *
 * Auth: none required for /v3/ohlc.
 */

import { RateLimiter } from "../lib/rate-limiter";
import type { Candle } from "../../../src/sources/types";

export type BitsoPagedPair = "BTC/MXN" | "BTC/BRL" | "BTC/ARS" | "BTC/USD";

const PAIR_TO_BITSO: Record<BitsoPagedPair, string> = {
  "BTC/MXN": "btc_mxn",
  "BTC/BRL": "btc_brl",
  "BTC/ARS": "btc_ars",
  "BTC/USD": "btc_usd",
};

const ENDPOINT_BASE = "https://api.bitso.com";
const USER_AGENT = "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)";
const STEP_MS = 60_000;
/** Max window per request — Bitso returns up to ~1 day of 1m buckets. */
const WINDOW_MS = 24 * 60 * 60 * 1000;

interface BitsoOhlcBucket {
  bucket_start_time: number;
  first_trade_time?: number;
  last_trade_time?: number;
  first_rate: string;
  last_rate: string;
  min_rate: string;
  max_rate: string;
  trade_count: number;
  volume: string;
  vwap?: string;
}

interface BitsoOhlcResponse {
  success: boolean;
  payload?: BitsoOhlcBucket[];
  error?: { code: string; message: string };
}

export interface BitsoPagedDeps {
  fetchFn?: typeof fetch;
  rateLimiter?: RateLimiter;
}

export class BitsoPagedApiSource {
  static readonly name = "bitso-paged";
  static readonly supportedPairs: ReadonlyArray<BitsoPagedPair> = [
    "BTC/MXN",
    "BTC/BRL",
    "BTC/ARS",
    "BTC/USD",
  ];

  private readonly fetchFn: typeof fetch;
  private readonly rateLimiter: RateLimiter;

  constructor(deps: BitsoPagedDeps = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.rateLimiter = deps.rateLimiter ?? new RateLimiter({ ratePerSec: 0.8, burst: 2 });
  }

  isSupported(pair: string): pair is BitsoPagedPair {
    return (BitsoPagedApiSource.supportedPairs as ReadonlyArray<string>).includes(pair);
  }

  bitsoBook(pair: BitsoPagedPair): string {
    return PAIR_TO_BITSO[pair];
  }

  urlFor(pair: BitsoPagedPair, startMs: number, endMs: number): string {
    return `${ENDPOINT_BASE}/v3/ohlc?book=${PAIR_TO_BITSO[pair]}&time_bucket=60&start=${startMs}&end=${endMs}`;
  }

  async *fetch(
    pair: BitsoPagedPair,
    fromTs: Date,
    toTs: Date,
  ): AsyncIterable<Candle> {
    if (!this.isSupported(pair)) {
      throw new Error(`BitsoPagedApiSource: unsupported pair ${pair}`);
    }
    if (fromTs >= toTs) return;

    const endTotalMs = toTs.getTime();
    let startMs = fromTs.getTime();
    const seenMs = new Set<number>();
    let pages = 0;

    while (startMs < endTotalMs) {
      if (pages++ > 100_000) {
        throw new Error(`BitsoPagedApiSource.fetch: page cap exceeded for ${pair}`);
      }
      const pageEndMs = Math.min(startMs + WINDOW_MS, endTotalMs);
      await this.rateLimiter.acquire();
      const url = this.urlFor(pair, startMs, pageEndMs);
      const res = await this.fetchFn(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`BitsoPagedApiSource.fetch: HTTP ${res.status} from ${url}`);
      }
      const body = (await res.json()) as BitsoOhlcResponse;
      if (body.success === false) {
        const msg = body.error?.message ?? "unknown";
        throw new Error(`BitsoPagedApiSource.fetch: API error: ${msg}`);
      }
      const rows = body.payload ?? [];

      let maxMs = -1;
      for (const r of rows) {
        const ms = Number(r.bucket_start_time);
        if (!Number.isFinite(ms) || ms <= 0) continue;
        if (ms >= endTotalMs) {
          maxMs = Math.max(maxMs, ms);
          continue;
        }
        if (seenMs.has(ms)) continue;
        seenMs.add(ms);
        if (ms > maxMs) maxMs = ms;

        const open = Number(r.first_rate);
        const close = Number(r.last_rate);
        const high = Number(r.max_rate);
        const low = Number(r.min_rate);
        const volume = Number(r.volume);
        if (![open, high, low, close].every(Number.isFinite)) continue;
        if (open <= 0 || high <= 0 || low <= 0 || close <= 0) continue;
        const safeVolume = Number.isFinite(volume) ? volume : 0;

        yield { bucketTs: new Date(ms), open, high, low, close, volume: safeVolume };
      }

      if (rows.length === 0) {
        // Empty window — advance past pageEndMs to keep scanning the
        // requested range (the book may have had downtime / no trades, then
        // resume). If we've reached the end, the outer loop terminates.
        startMs = pageEndMs;
        continue;
      }
      const nextStart = (maxMs > 0 ? maxMs : pageEndMs) + STEP_MS;
      if (nextStart <= startMs) {
        startMs = pageEndMs;
      } else {
        startMs = nextStart;
      }
    }
  }
}
