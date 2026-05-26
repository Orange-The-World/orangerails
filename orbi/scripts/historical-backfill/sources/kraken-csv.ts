/**
 * Kraken historical-backfill source — bulk OHLCVT CSV bundle from Kraken's
 * official Google Drive portal.
 *
 * Kraken's portal: https://support.kraken.com/articles/360047124832
 *   (page links to a public Google Drive folder of per-quarter ZIPs)
 * Drive folder: https://drive.google.com/drive/folders/15RSlNuW_h0kVM8or8McOGOMfHeBFvFGI
 *
 * As of 2026-05-26 the portal exposes 13 quarterly ZIPs covering Q1 2023 →
 * Q1 2026. (The article copy says "back to 2013" but the public folder only
 * hosts 2023+. Pre-2023 history is not on the portal at the moment; if
 * the maintainer needs it we'd fall through to the paged REST API in a future B.4.)
 *
 * Each ZIP contains many CSVs, one per (pair, granularity) — file naming
 * pattern: <KRAKEN_PAIR>_<MINUTES>.csv (e.g. XBTUSD_1.csv for 1-minute
 * XBT/USD). Each row is comma-separated, NO HEADER:
 *   <unix_seconds>,<open>,<high>,<low>,<close>,<volume>,<num_trades>
 *
 * Kraken uses "XBT" not "BTC" in symbols. The plug-in's input is ORBI's
 * canonical "BTC/X" notation; we map to Kraken's XBTX internally.
 *
 * Pair availability at 1-minute granularity:
 *   - BTC/USD → XBTUSD_1.csv
 *   - BTC/EUR → XBTEUR_1.csv
 *   - BTC/GBP → XBTGBP_1.csv
 *   - BTC/CAD → XBTCAD_1.csv
 *   - BTC/AUD → XBTAUD_1.csv
 *   - BTC/JPY → XBTJPY_1.csv
 *   - BTC/CHF → XBTCHF_1.csv
 *
 * Download strategy:
 *   - For each quarter in [from, to], fetch the corresponding Kraken_OHLCVT_QN_YYYY.zip
 *     from Drive, extract just the per-pair 1-minute CSV, concat into one
 *     local file at /tmp/orbi-backfill/Kraken_<XBTPAIR>_1.csv.
 *   - Drive's "uc?export=download" endpoint returns an HTML interstitial for
 *     files >100 MB asking the user to "confirm"; the form action posts back
 *     to drive.usercontent.google.com with confirm=t. We can short-circuit
 *     that interstitial by going straight to drive.usercontent.google.com
 *     with confirm=t — verified working 2026-05-26.
 *
 * This module does NOT extend BaseSource — same reason as bitstamp-csv: one
 * big bulk download per quarter, not paged candle fetches.
 */

import { createWriteStream, mkdirSync, statSync, existsSync, createReadStream, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import { parseCsv } from "../lib/csv-parser";
import type { Candle } from "../../../src/sources/types";

export type KrakenSupportedPair =
  | "BTC/USD"
  | "BTC/EUR"
  | "BTC/GBP"
  | "BTC/CAD"
  | "BTC/AUD"
  | "BTC/JPY"
  | "BTC/CHF";

/** ORBI canonical pair → Kraken bulk-CSV pair code. */
const PAIR_TO_KRAKEN: Record<KrakenSupportedPair, string> = {
  "BTC/USD": "XBTUSD",
  "BTC/EUR": "XBTEUR",
  "BTC/GBP": "XBTGBP",
  "BTC/CAD": "XBTCAD",
  "BTC/AUD": "XBTAUD",
  "BTC/JPY": "XBTJPY",
  "BTC/CHF": "XBTCHF",
};

/**
 * Quarter ZIP name → Google Drive file ID. Verified 2026-05-26 against the
 * public folder. If Kraken ever rotates these IDs we'll get a 404 on
 * download and need to refresh the map (instructions in README).
 */
export const KRAKEN_DRIVE_FILE_IDS: Record<string, string> = {
  "Kraken_OHLCVT_Q1_2023.zip": "17ghRNMQGK0Is7_by784qGzP1eCUokI2V",
  "Kraken_OHLCVT_Q2_2023.zip": "1QGRW_Qg9H2pC2dBTk0b6vlGi93AFiZfI",
  "Kraken_OHLCVT_Q3_2023.zip": "1gE9XyED-bm4ks1PZomDnlpt-f_r9nWu6",
  "Kraken_OHLCVT_Q4_2023.zip": "1c3HQ0-YMvhAuGwo-f4BKAdhkG8Cj6jxx",
  "Kraken_OHLCVT_Q1_2024.zip": "1JkH3c13madqdpF-dzXoseX_sYY1E2iHx",
  "Kraken_OHLCVT_Q2_2024.zip": "1nb0vaPClwYoAGnWjYXkjrBEPQC58lmPN",
  "Kraken_OHLCVT_Q3_2024.zip": "1_GQZ7gqQ9BcIEIA_L8zPwfXTUjxIKEIk",
  "Kraken_OHLCVT_Q4_2024.zip": "1fCJPY1SwJa6py-Dln-Q7S349lBXyH0Dl",
  "Kraken_OHLCVT_Q1_2025.zip": "1dXJummu2qF5J6UC4rQh0T0XmriqngONG",
  "Kraken_OHLCVT_Q2_2025.zip": "1THrQiXsMSyhGb4DmUPCbivAKXoI8rxEG",
  "Kraken_OHLCVT_Q3_2025.zip": "1N6fg5ceXx9iQHEGHyvqUUlgo3NPsRpT7",
  "Kraken_OHLCVT_Q4_2025.zip": "1QbPHLP0TTGo-lqwKn8M-_Xo_oexXlEnB",
  "Kraken_OHLCVT_Q1_2026.zip": "15QxEf_-rRS-Yt7uERCI41HMcQQPKzSHq",
};

const DOWNLOAD_DIR = "/tmp/orbi-backfill";
const USER_AGENT = "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)";

/** Kraken CSV row column names (no header in file — we supply this). */
export const KRAKEN_CSV_COLUMNS = ["unix", "open", "high", "low", "close", "volume", "trades"] as const;

export interface QuarterRef {
  year: number;
  /** 1..4 */
  quarter: 1 | 2 | 3 | 4;
  zipName: string;
}

export interface DownloadResult {
  pair: KrakenSupportedPair;
  /** Path to the concatenated per-pair 1-minute CSV (header-less). */
  path: string;
  bytes: number;
  /** Source ZIPs that were combined into the CSV. */
  quarters: QuarterRef[];
}

export interface KrakenCsvDeps {
  /** Injectable fetch for tests. */
  fetchFn?: typeof fetch;
}

export class KrakenCsvSource {
  static readonly name = "kraken-csv";
  static readonly supportedPairs: ReadonlyArray<KrakenSupportedPair> = [
    "BTC/USD",
    "BTC/EUR",
    "BTC/GBP",
    "BTC/CAD",
    "BTC/AUD",
    "BTC/JPY",
    "BTC/CHF",
  ];

  private readonly fetchFn: typeof fetch;

  constructor(deps: KrakenCsvDeps = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  isSupported(pair: string): pair is KrakenSupportedPair {
    return (KrakenCsvSource.supportedPairs as ReadonlyArray<string>).includes(pair);
  }

  krakenSymbol(pair: KrakenSupportedPair): string {
    return PAIR_TO_KRAKEN[pair];
  }

  /**
   * Enumerate every Kraken quarterly ZIP that overlaps [from, to).
   * Half-open on the upper bound — consistent with the parse() convention.
   * If `to` falls exactly on a quarter boundary, that quarter is excluded.
   */
  quartersInRange(from: Date, to: Date): QuarterRef[] {
    if (from >= to) return [];
    const out: QuarterRef[] = [];

    // Start quarter index = year * 4 + (0..3).
    const startIdx = from.getUTCFullYear() * 4 + Math.floor(from.getUTCMonth() / 3);
    // End quarter index — last quarter touched. Subtract 1 ms from `to` to
    // implement the half-open convention.
    const adjEnd = new Date(to.getTime() - 1);
    const endIdx = adjEnd.getUTCFullYear() * 4 + Math.floor(adjEnd.getUTCMonth() / 3);

    for (let i = startIdx; i <= endIdx; i++) {
      const y = Math.floor(i / 4);
      const q = ((i % 4) + 1) as 1 | 2 | 3 | 4;
      out.push({ year: y, quarter: q, zipName: `Kraken_OHLCVT_Q${q}_${y}.zip` });
    }
    return out;
  }

  /**
   * Build the Google Drive direct-download URL for a quarter ZIP.
   * Uses drive.usercontent.google.com + confirm=t to skip the >100 MB
   * HTML interstitial that drive.google.com/uc serves first.
   */
  urlForQuarter(zipName: string): string {
    const id = KRAKEN_DRIVE_FILE_IDS[zipName];
    if (!id) throw new Error(`KrakenCsvSource: unknown quarter ZIP ${zipName} (no Drive ID mapped)`);
    return `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
  }

  /**
   * Download every quarter ZIP overlapping [from, to], extract the per-pair
   * 1-minute CSV, and concatenate into one file at
   * /tmp/orbi-backfill/Kraken_<XBTPAIR>_1.csv.
   *
   * Quarters are processed in chronological order, so the output CSV is in
   * chronological order. Already-downloaded ZIPs in DOWNLOAD_DIR are reused.
   */
  async download(pair: KrakenSupportedPair, from: Date, to: Date): Promise<DownloadResult> {
    if (!this.isSupported(pair)) {
      throw new Error(`KrakenCsvSource: unsupported pair ${pair}`);
    }
    mkdirSync(DOWNLOAD_DIR, { recursive: true });
    const krakenSym = PAIR_TO_KRAKEN[pair];
    const targetCsvName = `${krakenSym}_1.csv`;
    const outPath = `${DOWNLOAD_DIR}/Kraken_${krakenSym}_1.csv`;
    writeFileSync(outPath, ""); // truncate

    const quarters = this.quartersInRange(from, to);
    if (quarters.length === 0) {
      throw new Error(`KrakenCsvSource.download: empty quarter range for ${from.toISOString()} → ${to.toISOString()}`);
    }

    for (const q of quarters) {
      const zipPath = `${DOWNLOAD_DIR}/${q.zipName}`;
      if (!existsSync(zipPath) || statSync(zipPath).size < 1024 * 1024) {
        const url = this.urlForQuarter(q.zipName);
        const res = await this.fetchFn(url, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/octet-stream" },
        });
        if (!res.ok) {
          throw new Error(`KrakenCsvSource.download: HTTP ${res.status} from ${url}`);
        }
        if (!res.body) {
          throw new Error(`KrakenCsvSource.download: empty body from ${url}`);
        }
        const nodeStream = Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
        await pipeline(nodeStream, createWriteStream(zipPath));
        const st = statSync(zipPath);
        if (st.size < 10 * 1024 * 1024) {
          // Drive sometimes returns a small HTML page instead of the file
          // when rate-limited or the share link rotated.
          throw new Error(`KrakenCsvSource.download: ${q.zipName} suspiciously small (${st.size} bytes) — Drive may have served an interstitial. Verify the file ID map.`);
        }
      }

      // Extract just the per-pair 1-minute CSV from the ZIP. We use the
      // system unzip binary in -p mode (write to stdout) so we never
      // materialise the entire archive (some quarters are >500 MB).
      const extractedDir = `${DOWNLOAD_DIR}/.kraken-extract-${q.year}-Q${q.quarter}`;
      mkdirSync(extractedDir, { recursive: true });
      try {
        // unzip with -j (no paths) -o (overwrite) -d (target dir) PATTERN
        execFileSync("unzip", ["-jo", zipPath, targetCsvName, "-d", extractedDir], { stdio: ["ignore", "ignore", "pipe"] });
      } catch (err) {
        // Some quarters genuinely don't have every pair (e.g. AUD launched
        // mid-2024). Treat as "no rows for this quarter" rather than fatal.
        const msg = err instanceof Error ? err.message : String(err);
        if (/cannot find|not matched/i.test(msg) || (err as { status?: number }).status === 11) {
          continue;
        }
        throw new Error(`KrakenCsvSource.download: unzip failed for ${q.zipName} (${targetCsvName}): ${msg.slice(0, 200)}`);
      }
      const extractedPath = `${extractedDir}/${targetCsvName}`;
      if (!existsSync(extractedPath)) continue;
      const data = createReadStream(extractedPath);
      await new Promise<void>((resolve, reject) => {
        const ws = createWriteStream(outPath, { flags: "a" });
        data.pipe(ws);
        ws.on("finish", () => resolve());
        ws.on("error", reject);
        data.on("error", reject);
      });
      // Clean up the per-quarter extracted CSV. Keep the ZIP — it's the
      // expensive download.
      try {
        unlinkSync(extractedPath);
        for (const f of readdirSync(extractedDir)) unlinkSync(`${extractedDir}/${f}`);
      } catch {
        // best-effort
      }
    }

    const stat = statSync(outPath);
    if (stat.size === 0) {
      throw new Error(`KrakenCsvSource.download: no rows extracted for ${pair} in [${from.toISOString()}, ${to.toISOString()}]. The pair may not exist in any quarter of that range.`);
    }
    return { pair, path: outPath, bytes: stat.size, quarters };
  }

  /**
   * Stream-parse the concatenated header-less Kraken CSV into Candles. Yields
   * only rows whose bucketTs is within [fromTs, toTs).
   *
   * Kraken's volume column is in the SOURCE currency (BTC) at 1-minute
   * granularity — that matches our Candle.volume convention.
   */
  async *parse(
    csvPath: string,
    fromTs: Date,
    toTs: Date,
  ): AsyncIterable<Candle> {
    if (!existsSync(csvPath)) {
      throw new Error(`KrakenCsvSource.parse: file not found: ${csvPath}`);
    }
    const fromMs = fromTs.getTime();
    const toMs = toTs.getTime();
    const stream = createReadStream(csvPath, { encoding: "utf8" });

    for await (const row of parseCsv(stream, { header: KRAKEN_CSV_COLUMNS as unknown as string[] })) {
      const unixSec = Number(row.unix);
      if (!Number.isFinite(unixSec) || unixSec <= 0) continue;
      const bucketMs = unixSec > 1e12 ? unixSec : unixSec * 1000;
      if (bucketMs < fromMs || bucketMs >= toMs) continue;

      const open = Number(row.open);
      const high = Number(row.high);
      const low = Number(row.low);
      const close = Number(row.close);
      const volume = Number(row.volume ?? "0");

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
