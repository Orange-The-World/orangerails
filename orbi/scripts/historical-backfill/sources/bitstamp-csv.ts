/**
 * Bitstamp historical-backfill source — CSV bundle from cryptodatadownload.com.
 *
 * The cryptodatadownload.com mirror publishes a rolling Bitstamp 1-min OHLCV
 * bundle per pair, refreshed periodically. The free files cover the most
 * recent several months (~150-200 days as of 2026-05). For older data we'd
 * fall back to Bitstamp's own historical-trades API (see README).
 *
 * Pair availability on the mirror at the minute granularity:
 *   - BTC/USD  YES — Bitstamp_BTCUSD_minute.csv
 *   - BTC/EUR  YES — Bitstamp_BTCEUR_minute.csv
 *   - BTC/GBP  NO  — mirror has only daily / hourly for GBP. README documents
 *                    the fallback (Bitstamp /api/v2/ohlc with paged start=).
 *
 * CSV format (descending time, newest first):
 *   Line 1: banner — "https://www.CryptoDataDownload.com"
 *   Line 2: header — unix,date,symbol,open,high,low,close,Volume BTC,Volume USD
 *   Line 3+: 1622011380,2021-05-26 06:43:00,BTC/USD,40691.34,...
 *
 * This module does NOT extend BaseSource — its contract is different:
 *   - One big bulk download (not paged candle fetches)
 *   - Yields Candle stream from a local file via streaming CSV parse
 *   - The orchestrator handles checkpointing + batched writes
 */

import { createWriteStream, mkdirSync, statSync, existsSync, createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { parseCsv } from "../lib/csv-parser";
import type { Candle } from "../../../src/sources/types";

export type BitstampCsvPair = "BTC/USD" | "BTC/EUR";

const PAIR_TO_FILE: Record<BitstampCsvPair, string> = {
  "BTC/USD": "Bitstamp_BTCUSD_minute.csv",
  "BTC/EUR": "Bitstamp_BTCEUR_minute.csv",
};

const MIRROR_BASE = "https://www.cryptodatadownload.com/cdd";
const DOWNLOAD_DIR = "/tmp/orbi-backfill";
const USER_AGENT = "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)";

export interface DownloadResult {
  pair: BitstampCsvPair;
  path: string;
  bytes: number;
  url: string;
}

export interface BitstampCsvDeps {
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
}

export class BitstampCsvSource {
  static readonly name = "bitstamp-csv";
  static readonly supportedPairs: ReadonlyArray<BitstampCsvPair> = ["BTC/USD", "BTC/EUR"];

  private readonly fetchFn: typeof fetch;

  constructor(deps: BitstampCsvDeps = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  isSupported(pair: string): pair is BitstampCsvPair {
    return (BitstampCsvSource.supportedPairs as ReadonlyArray<string>).includes(pair);
  }

  urlFor(pair: BitstampCsvPair): string {
    return `${MIRROR_BASE}/${PAIR_TO_FILE[pair]}`;
  }

  /**
   * Download the full CSV for the pair to /tmp/orbi-backfill/<pair>.csv.
   * Overwrites any previous download. Returns local path + byte count.
   */
  async download(pair: BitstampCsvPair): Promise<DownloadResult> {
    if (!this.isSupported(pair)) {
      throw new Error(`BitstampCsvSource: unsupported pair ${pair}`);
    }
    mkdirSync(DOWNLOAD_DIR, { recursive: true });
    const path = `${DOWNLOAD_DIR}/${PAIR_TO_FILE[pair]}`;
    const url = this.urlFor(pair);

    const res = await this.fetchFn(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/csv" },
    });
    if (!res.ok) {
      throw new Error(`BitstampCsvSource.download: HTTP ${res.status} from ${url}`);
    }
    if (!res.body) {
      throw new Error(`BitstampCsvSource.download: empty body from ${url}`);
    }

    // Node's fetch returns a web ReadableStream; convert to Node Readable.
    const nodeStream = Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
    await pipeline(nodeStream, createWriteStream(path));

    const stat = statSync(path);
    if (stat.size < 1024) {
      throw new Error(`BitstampCsvSource.download: file suspiciously small (${stat.size} bytes) from ${url}`);
    }
    return { pair, path, bytes: stat.size, url };
  }

  /**
   * Stream-parse the local CSV into Candles. Yields only rows whose bucketTs
   * is within [fromTs, toTs). Tolerates the cryptodatadownload banner line
   * and ascending OR descending row order.
   *
   * The Bitstamp/cryptodatadownload mirror writes Volume BTC as the volume
   * in the SOURCE currency (BTC) — that matches our Candle.volume convention,
   * so it feeds the VW-median directly.
   */
  async *parse(
    csvPath: string,
    fromTs: Date,
    toTs: Date,
  ): AsyncIterable<Candle> {
    if (!existsSync(csvPath)) {
      throw new Error(`BitstampCsvSource.parse: file not found: ${csvPath}`);
    }
    const fromMs = fromTs.getTime();
    const toMs = toTs.getTime();
    const stream = createReadStream(csvPath, { encoding: "utf8" });

    for await (const row of parseCsv(stream, { skipLines: 1 })) {
      const unixSec = Number(row.unix);
      if (!Number.isFinite(unixSec) || unixSec <= 0) continue;
      // cryptodatadownload sometimes writes unix in ms instead of seconds;
      // detect by magnitude (anything > 10^12 is ms).
      const bucketMs = unixSec > 1e12 ? unixSec : unixSec * 1000;
      if (bucketMs < fromMs || bucketMs >= toMs) continue;

      const open = Number(row.open);
      const high = Number(row.high);
      const low = Number(row.low);
      const close = Number(row.close);
      const volume = Number(row["Volume BTC"] ?? row["volume"] ?? "0");

      if (![open, high, low, close, volume].every(Number.isFinite)) continue;
      if (open <= 0 || high <= 0 || low <= 0 || close <= 0) continue;

      yield {
        bucketTs: new Date(bucketMs),
        open,
        high,
        low,
        close,
        volume,
      };
    }
  }
}
