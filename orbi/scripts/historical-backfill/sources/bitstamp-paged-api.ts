/**
 * Bitstamp paged-API historical-backfill source — Phase B.3.
 *
 * Where the B.1 mirror plug-in (`bitstamp-csv.ts`) ends, this one begins.
 * The cryptodatadownload.com mirror only carries a rolling ~6-month window;
 * for deep history we walk Bitstamp's own public OHLC endpoint page-by-page.
 *
 *   GET https://www.bitstamp.net/api/v2/ohlc/{pair}/?step=60&start=<unix>&limit=1000
 *
 * Response shape (same as the live `bitstamp.ts` source plug-in):
 *   {
 *     "data": {
 *       "pair": "BTC/USD",
 *       "ohlc": [
 *         {"timestamp":"1622011200","open":"...","high":"...","low":"...",
 *          "close":"...","volume":"..."},
 *         ...   // ascending by timestamp, up to `limit` entries
 *       ]
 *     }
 *   }
 *
 * Pagination:
 *   - 1000 candles per request = 1000 * 60 s = ~16.6 h per page.
 *   - We start at `from`, fetch a page, take the LAST returned timestamp,
 *     bump start = lastTs + 60, repeat until the response either runs past
 *     `to` or comes back empty (no more history at or after start).
 *
 * Depth available: Bitstamp BTC/USD goes back to ~2011-08-18; BTC/EUR to
 * ~2017-12-05; BTC/GBP to ~2022-05-23. Older minutes may be sparse — the
 * orchestrator drops any candle with all-zero OHLC.
 *
 * Rate limit: Bitstamp publishes 8000 requests per 10 minutes per IP (~13
 * rps). We default to 6 rps (well under cap, leaves headroom for retries
 * and concurrent runs). The shared RateLimiter handles pacing.
 *
 * Auth: none required for the public OHLC endpoint.
 *
 * Output convention: yields `Candle` objects with `volume` in the SOURCE
 * currency (BTC) — Bitstamp's `volume` field is base-asset volume, matching
 * our Candle contract.
 */

import { RateLimiter } from "../lib/rate-limiter";
import type { Candle } from "../../../src/sources/types";

export type BitstampPagedPair = "BTC/USD" | "BTC/EUR" | "BTC/GBP";

const PAIR_TO_BITSTAMP: Record<BitstampPagedPair, string> = {
  "BTC/USD": "btcusd",
  "BTC/EUR": "btceur",
  "BTC/GBP": "btcgbp",
};

const ENDPOINT_BASE = "https://www.bitstamp.net/api/v2";
const USER_AGENT = "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)";
const PAGE_LIMIT = 1000;
const STEP_SEC = 60;

interface BitstampOhlcRow {
  timestamp: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

interface BitstampOhlcResponse {
  data?: {
    pair?: string;
    ohlc?: BitstampOhlcRow[];
  };
}

export interface BitstampPagedDeps {
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
  /** Injectable rate limiter (tests may pass a no-op). */
  rateLimiter?: RateLimiter;
}

export class BitstampPagedApiSource {
  static readonly name = "bitstamp-paged";
  static readonly supportedPairs: ReadonlyArray<BitstampPagedPair> = [
    "BTC/USD",
    "BTC/EUR",
    "BTC/GBP",
  ];

  private readonly fetchFn: typeof fetch;
  private readonly rateLimiter: RateLimiter;

  constructor(deps: BitstampPagedDeps = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.rateLimiter = deps.rateLimiter ?? new RateLimiter({ ratePerSec: 6, burst: 6 });
  }

  isSupported(pair: string): pair is BitstampPagedPair {
    return (BitstampPagedApiSource.supportedPairs as ReadonlyArray<string>).includes(pair);
  }

  bitstampPair(pair: BitstampPagedPair): string {
    return PAIR_TO_BITSTAMP[pair];
  }

  /** Build the URL for one page starting at `startSec` unix seconds. */
  urlFor(pair: BitstampPagedPair, startSec: number, limit: number = PAGE_LIMIT): string {
    return `${ENDPOINT_BASE}/ohlc/${PAIR_TO_BITSTAMP[pair]}/?step=${STEP_SEC}&start=${startSec}&limit=${limit}`;
  }

  /**
   * Stream Candles across [fromTs, toTs) by paging the Bitstamp OHLC endpoint.
   * The orchestrator handles batching / checkpoint / DB writes.
   *
   * Termination conditions:
   *   - returned page is empty → no more data at/after current start
   *   - last returned timestamp >= toTs → caller's window covered
   *   - safety cap: 100,000 pages (~5.7 years per call) — Bitstamp historical
   *     depth is well within this. If we ever exceed, we throw; that's a
   *     "you forgot to set `to`" bug, not a normal case.
   */
  async *fetch(
    pair: BitstampPagedPair,
    fromTs: Date,
    toTs: Date,
  ): AsyncIterable<Candle> {
    if (!this.isSupported(pair)) {
      throw new Error(`BitstampPagedApiSource: unsupported pair ${pair}`);
    }
    if (fromTs >= toTs) return;

    const toMs = toTs.getTime();
    let startSec = Math.floor(fromTs.getTime() / 1000);
    const lastIncludedSec = Math.floor((toMs - 1) / 1000);
    const seenTimestamps = new Set<number>();
    let pages = 0;

    while (startSec <= lastIncludedSec) {
      if (pages++ > 100_000) {
        throw new Error(`BitstampPagedApiSource.fetch: page cap exceeded for ${pair} ${fromTs.toISOString()}→${toTs.toISOString()}`);
      }
      await this.rateLimiter.acquire();
      const url = this.urlFor(pair, startSec);
      const res = await this.fetchFn(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`BitstampPagedApiSource.fetch: HTTP ${res.status} from ${url}`);
      }
      const body = (await res.json()) as BitstampOhlcResponse;
      const rows = body.data?.ohlc;
      if (!Array.isArray(rows) || rows.length === 0) {
        return; // no more history at this start
      }

      let maxRowSec = -1;
      let yieldedThisPage = 0;

      for (const row of rows) {
        const tsSec = Number(row.timestamp);
        if (!Number.isFinite(tsSec) || tsSec <= 0) continue;
        const bucketMs = tsSec * 1000;
        if (bucketMs >= toMs) {
          // Past the requested window — page is sorted ascending so we can
          // stop entirely. Still update maxRowSec so the outer loop exits.
          maxRowSec = Math.max(maxRowSec, tsSec);
          break;
        }
        if (tsSec > maxRowSec) maxRowSec = tsSec;
        if (seenTimestamps.has(tsSec)) continue; // de-dup if Bitstamp returns overlap
        seenTimestamps.add(tsSec);

        const open = Number(row.open);
        const high = Number(row.high);
        const low = Number(row.low);
        const close = Number(row.close);
        const volume = Number(row.volume);
        if (![open, high, low, close, volume].every(Number.isFinite)) continue;
        if (open <= 0 || high <= 0 || low <= 0 || close <= 0) continue;

        yield { bucketTs: new Date(bucketMs), open, high, low, close, volume };
        yieldedThisPage++;
      }

      if (maxRowSec < 0) {
        // No usable timestamps in this page (all invalid). Bump to next bucket
        // to avoid an infinite loop.
        startSec += STEP_SEC;
        continue;
      }
      // Advance to one bucket past the last seen timestamp.
      const nextStart = maxRowSec + STEP_SEC;
      // If the API stalled (rare — same maxRowSec twice), force advance.
      if (nextStart <= startSec) {
        startSec += STEP_SEC;
      } else {
        startSec = nextStart;
      }
      // If a page yielded nothing AND didn't move start forward enough to
      // matter, the window is genuinely empty — break.
      if (yieldedThisPage === 0 && rows.length < PAGE_LIMIT) {
        return;
      }
    }
  }
}
