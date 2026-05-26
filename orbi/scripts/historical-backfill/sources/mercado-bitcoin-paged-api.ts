/**
 * Mercado Bitcoin paged-API historical-backfill source — Phase B.3.
 *
 * Brazilian exchange. NOT Mercado Pago. Two endpoint families:
 *
 *   1) Modern v4 1-minute candles (TradingView UDF shape):
 *        GET https://api.mercadobitcoin.net/api/v4/candles
 *            ?symbol={SYMBOL}&resolution=1m&from=<unix_sec>&to=<unix_sec>
 *
 *      Response:
 *        { "t":[...unix_sec], "o":[...], "h":[...], "l":[...], "c":[...], "v":[...] }
 *
 *      Symbols MUST be hyphenated BASE-QUOTE (e.g. BTC-BRL). Sending
 *      BTCBRL or BTC/BRL returns "SYMBOL_IS_INVALID" — verified 2026-05-26.
 *      Returned `t` is unix-seconds.
 *
 *   2) Legacy day-summary (older v1-style API, useful as a sanity check
 *      and for years pre-2020 where v4 may be sparse):
 *        GET https://www.mercadobitcoin.net/api/{base}/day-summary/{YYYY}/{MM}/{DD}/
 *      Response: { date, opening, closing, lowest, highest, volume, ... }
 *      We emit one daily Candle for those.
 *
 * Strategy:
 *   - Default path is v4 candles in 1-day windows (~1440 buckets per call).
 *   - If `--legacy-day-summary` is passed via the orchestrator (B.5 work,
 *     not wired yet) we'll fall through to (2). For B.3 we ship v4 only.
 *
 * Pairs supported on v4 (verified 2026-05-26):
 *   - BTC/BRL  (flagship, longest history)
 *   - BTC/USDT (added 2021)
 *   - BTC/USDC (added 2022)
 *
 * Pagination: v4 returns up to ~1440 rows per call. Window-walk in 24h
 * chunks, advance by `last_t + 60`, terminate on empty `t`.
 *
 * Rate limit: not formally documented. Mercado Bitcoin's reverse-proxy
 * (Cloudflare) starts 429-ing aggressive callers; default conservatively
 * to 1 rps with burst 2.
 *
 * Auth: none required for /api/v4/candles or the legacy day-summary.
 */

import { RateLimiter } from "../lib/rate-limiter";
import type { Candle } from "../../../src/sources/types";

export type MercadoPagedPair = "BTC/BRL" | "BTC/USDT" | "BTC/USDC";

const PAIR_TO_MB: Record<MercadoPagedPair, string> = {
  "BTC/BRL": "BTC-BRL",
  "BTC/USDT": "BTC-USDT",
  "BTC/USDC": "BTC-USDC",
};

const ENDPOINT_BASE = "https://api.mercadobitcoin.net";
const USER_AGENT = "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)";
const STEP_SEC = 60;
/** Window per call (24h of 1-min buckets). */
const WINDOW_SEC = 24 * 60 * 60;

interface MercadoCandlesResponse {
  t?: number[];
  o?: Array<string | number>;
  h?: Array<string | number>;
  l?: Array<string | number>;
  c?: Array<string | number>;
  v?: Array<string | number>;
  s?: string; // status: "ok" | "no_data"
  code?: string;
  message?: string;
}

export interface MercadoPagedDeps {
  fetchFn?: typeof fetch;
  rateLimiter?: RateLimiter;
}

export class MercadoBitcoinPagedApiSource {
  static readonly name = "mercado-bitcoin-paged";
  static readonly supportedPairs: ReadonlyArray<MercadoPagedPair> = [
    "BTC/BRL",
    "BTC/USDT",
    "BTC/USDC",
  ];

  private readonly fetchFn: typeof fetch;
  private readonly rateLimiter: RateLimiter;

  constructor(deps: MercadoPagedDeps = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.rateLimiter = deps.rateLimiter ?? new RateLimiter({ ratePerSec: 1, burst: 2 });
  }

  isSupported(pair: string): pair is MercadoPagedPair {
    return (MercadoBitcoinPagedApiSource.supportedPairs as ReadonlyArray<string>).includes(pair);
  }

  mbSymbol(pair: MercadoPagedPair): string {
    return PAIR_TO_MB[pair];
  }

  urlFor(pair: MercadoPagedPair, fromSec: number, toSec: number): string {
    return `${ENDPOINT_BASE}/api/v4/candles?symbol=${PAIR_TO_MB[pair]}&resolution=1m&from=${fromSec}&to=${toSec}`;
  }

  async *fetch(
    pair: MercadoPagedPair,
    fromTs: Date,
    toTs: Date,
  ): AsyncIterable<Candle> {
    if (!this.isSupported(pair)) {
      throw new Error(`MercadoBitcoinPagedApiSource: unsupported pair ${pair}`);
    }
    if (fromTs >= toTs) return;

    const endTotalSec = Math.floor(toTs.getTime() / 1000);
    let fromSec = Math.floor(fromTs.getTime() / 1000);
    const seenSec = new Set<number>();
    let pages = 0;

    while (fromSec < endTotalSec) {
      if (pages++ > 100_000) {
        throw new Error(`MercadoBitcoinPagedApiSource.fetch: page cap exceeded for ${pair}`);
      }
      const pageToSec = Math.min(fromSec + WINDOW_SEC, endTotalSec);
      await this.rateLimiter.acquire();
      const url = this.urlFor(pair, fromSec, pageToSec);
      const res = await this.fetchFn(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`MercadoBitcoinPagedApiSource.fetch: HTTP ${res.status} from ${url}`);
      }
      const body = (await res.json()) as MercadoCandlesResponse;

      if (body.code) {
        throw new Error(`MercadoBitcoinPagedApiSource.fetch: API error: ${body.code} ${body.message ?? ""}`);
      }
      const ts = body.t ?? [];
      const opens = body.o ?? [];
      const highs = body.h ?? [];
      const lows = body.l ?? [];
      const closes = body.c ?? [];
      const vols = body.v ?? [];

      if (ts.length === 0) {
        // No candles in this window (pre-launch / gap). Advance to next chunk.
        fromSec = pageToSec;
        continue;
      }

      let maxTs = -1;
      for (let i = 0; i < ts.length; i++) {
        const t = Number(ts[i]);
        if (!Number.isFinite(t) || t <= 0) continue;
        if (t >= endTotalSec) {
          maxTs = Math.max(maxTs, t);
          continue;
        }
        if (seenSec.has(t)) continue;
        seenSec.add(t);
        if (t > maxTs) maxTs = t;

        const open = Number(opens[i]);
        const close = Number(closes[i]);
        const high = Number(highs[i] ?? opens[i]);
        const low = Number(lows[i] ?? opens[i]);
        const volume = Number(vols[i] ?? 0);
        if (![open, high, low, close].every(Number.isFinite)) continue;
        if (open <= 0 || high <= 0 || low <= 0 || close <= 0) continue;
        const safeVolume = Number.isFinite(volume) ? volume : 0;

        yield {
          bucketTs: new Date(t * 1000),
          open,
          high,
          low,
          close,
          volume: safeVolume,
        };
      }

      const nextStart = (maxTs > 0 ? maxTs : pageToSec) + STEP_SEC;
      if (nextStart <= fromSec) {
        fromSec = pageToSec;
      } else {
        fromSec = nextStart;
      }
    }
  }
}
