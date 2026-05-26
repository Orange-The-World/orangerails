/**
 * Historical-backfill orchestrator.
 *
 * CLI:
 *   bun run scripts/historical-backfill/orchestrator.ts bitstamp BTC/USD 2018-01-01 2026-05-25
 *   bun run scripts/historical-backfill/orchestrator.ts bitstamp BTC/USD 2018-01-01 2026-05-25 --resume
 *   bun run scripts/historical-backfill/orchestrator.ts bitstamp BTC/USD 2018-01-01 2026-05-25 --dry-run
 *   bun run scripts/historical-backfill/orchestrator.ts kraken   BTC/USD 2023-01-01 2026-05-25
 *   bun run scripts/historical-backfill/orchestrator.ts kraken   BTC/CAD 2024-01-01 2024-04-01 --dry-run
 *
 * Pipeline:
 *   1. Load env, resolve PROD Supabase ref (Phase B.1 is dev / dry-run only;
 *      real backfill needs founder sign-off).
 *   2. Download the source's CSV bundle (or reuse existing local file in --resume).
 *   3. Stream-parse rows; for each candle inside [from, to):
 *      a. Build an ExchangeRateInsert (single-source → tier "B-single",
 *         provider_count = 1, provenance = "historical-backfill").
 *      b. Append to a buffer.
 *      c. When buffer hits BATCH_SIZE, flush via BatchWriter, advance checkpoint.
 *   4. Final flush + clear checkpoint on clean completion.
 *
 * --dry-run: parses everything, batches everything, but never calls the SQL
 * executor. Prints row counts + sample first/last 3 rows.
 *
 * --resume: reads /tmp/orbi-backfill-{source}-{pair}.checkpoint.json. Skips
 * download if the local CSV already exists; skips already-completed buckets.
 */

import { readFileSync, existsSync } from "node:fs";
import { BitstampCsvSource, type BitstampCsvPair } from "./sources/bitstamp-csv";
import { KrakenCsvSource, type KrakenSupportedPair } from "./sources/kraken-csv";
import {
  BatchWriter,
  type ExchangeRateInsert,
} from "./lib/batch-writer";
import {
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
  newCheckpoint,
  type Checkpoint,
} from "./lib/checkpoint";
import type { Candle } from "../../src/sources/types";

const BATCH_SIZE = 500;
const PROGRESS_EVERY = 10_000;

// ----------------------------------------------------------------------------
// Env
// ----------------------------------------------------------------------------
function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const path = "/opt/bb-support/.env";
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#") || !s.includes("=")) continue;
    const [k, ...rest] = s.split("=");
    let v = rest.join("=").trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[k!.trim()] = v;
  }
  return env;
}

// ----------------------------------------------------------------------------
// Supabase Management API executor (only used outside --dry-run).
// ----------------------------------------------------------------------------
interface DbContext {
  projectRef: string;
  accessToken: string;
}

async function mgmtApiQuery(ctx: DbContext, sql: string): Promise<unknown> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ctx.projectRef}/database/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; Orange-Rails-ORBI/1.0)",
      Accept: "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) {
    throw new Error(`Mgmt API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

// ----------------------------------------------------------------------------
// Source registry
// ----------------------------------------------------------------------------
type SupportedSource = "bitstamp" | "kraken";

interface SourceAdapter {
  fetchCandles(pair: string, from: Date, to: Date, opts: { reuseExisting: boolean }): AsyncIterable<Candle>;
}

class BitstampAdapter implements SourceAdapter {
  constructor(private readonly src: BitstampCsvSource = new BitstampCsvSource()) {}

  async *fetchCandles(
    pair: string,
    from: Date,
    to: Date,
    opts: { reuseExisting: boolean },
  ): AsyncIterable<Candle> {
    if (!this.src.isSupported(pair)) {
      throw new Error(`bitstamp-csv: unsupported pair ${pair}. Supported: ${BitstampCsvSource.supportedPairs.join(", ")}`);
    }
    const pairTyped = pair as BitstampCsvPair;
    const downloadPath = `/tmp/orbi-backfill/Bitstamp_${pair.replace("/", "")}_minute.csv`;

    if (opts.reuseExisting && existsSync(downloadPath)) {
      console.log(`  [bitstamp-csv] reusing existing download: ${downloadPath}`);
    } else {
      console.log(`  [bitstamp-csv] downloading ${this.src.urlFor(pairTyped)}`);
      const dl = await this.src.download(pairTyped);
      console.log(`  [bitstamp-csv] downloaded ${dl.bytes} bytes → ${dl.path}`);
    }
    yield* this.src.parse(downloadPath, from, to);
  }
}

class KrakenAdapter implements SourceAdapter {
  constructor(private readonly src: KrakenCsvSource = new KrakenCsvSource()) {}

  async *fetchCandles(
    pair: string,
    from: Date,
    to: Date,
    opts: { reuseExisting: boolean },
  ): AsyncIterable<Candle> {
    if (!this.src.isSupported(pair)) {
      throw new Error(`kraken-csv: unsupported pair ${pair}. Supported: ${KrakenCsvSource.supportedPairs.join(", ")}`);
    }
    const pairTyped = pair as KrakenSupportedPair;
    const krakenSym = this.src.krakenSymbol(pairTyped);
    const downloadPath = `/tmp/orbi-backfill/Kraken_${krakenSym}_1.csv`;

    if (opts.reuseExisting && existsSync(downloadPath)) {
      console.log(`  [kraken-csv] reusing existing concatenated CSV: ${downloadPath}`);
    } else {
      const quarters = this.src.quartersInRange(from, to);
      console.log(`  [kraken-csv] downloading ${quarters.length} quarter ZIP(s) for ${pair} (${krakenSym})`);
      for (const q of quarters) console.log(`    - ${q.zipName}`);
      const dl = await this.src.download(pairTyped, from, to);
      console.log(`  [kraken-csv] concatenated ${dl.bytes} bytes → ${dl.path}`);
    }
    yield* this.src.parse(downloadPath, from, to);
  }
}

function getAdapter(source: SupportedSource): SourceAdapter {
  switch (source) {
    case "bitstamp": return new BitstampAdapter();
    case "kraken":   return new KrakenAdapter();
    default: throw new Error(`Unknown source: ${source}`);
  }
}

// ----------------------------------------------------------------------------
// Candle → ExchangeRateInsert mapper.
//
// Single-source historical fills land as tier 'B-single' (1 provider).
// The re-resolve pass in Phase B.5 will combine multiple historical sources
// per minute and upgrade tier where possible — that's a separate work item
// and explicitly out of scope here.
// ----------------------------------------------------------------------------
function candleToInsert(
  pair: string,
  candle: Candle,
  fetchedAtIso: string,
): ExchangeRateInsert {
  const [src, tgt] = pair.split("/") as [string, string];
  return {
    source_currency: src,
    target_currency: tgt,
    bucket_ts: candle.bucketTs.toISOString(),
    granularity: "1m",
    product: "ORBI-M",
    rate: candle.close,
    tier: "B-single",
    composite: false,
    composite_via: null,
    provider_count: 1,
    status: "CONFIRMED",
    fetched_at: fetchedAtIso,
    computed_at: fetchedAtIso,
  };
}

// ----------------------------------------------------------------------------
// Core orchestrator (exported for tests).
// ----------------------------------------------------------------------------
export interface BackfillOptions {
  source: SupportedSource;
  pair: string;
  from: Date;
  to: Date;
  dryRun: boolean;
  resume: boolean;
}

export interface BackfillSummary {
  rowsParsed: number;
  rowsWritten: number;
  rowsSkippedByCheckpoint: number;
  batches: number;
  errors: number;
  firstBucket: string | null;
  lastBucket: string | null;
  sampleFirst: ExchangeRateInsert[];
  sampleLast: ExchangeRateInsert[];
}

export interface BackfillDeps {
  adapter: SourceAdapter;
  writer: BatchWriter | null; // null in dry-run
  log?: (msg: string) => void;
}

export async function runBackfill(opts: BackfillOptions, deps: BackfillDeps): Promise<BackfillSummary> {
  const log = deps.log ?? ((s: string) => console.log(s));
  const fetchedAt = new Date().toISOString();

  let cp: Checkpoint = opts.resume
    ? loadCheckpoint(opts.source, opts.pair) ?? newCheckpoint(opts.source, opts.pair)
    : newCheckpoint(opts.source, opts.pair);
  const resumeFromMs = cp.lastCompletedBucketTs ? new Date(cp.lastCompletedBucketTs).getTime() : -1;

  const summary: BackfillSummary = {
    rowsParsed: 0,
    rowsWritten: 0,
    rowsSkippedByCheckpoint: 0,
    batches: 0,
    errors: 0,
    firstBucket: null,
    lastBucket: null,
    sampleFirst: [],
    sampleLast: [],
  };

  const buffer: ExchangeRateInsert[] = [];

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    summary.batches++;
    if (deps.writer) {
      const res = await deps.writer.write(buffer);
      summary.rowsWritten += res.written;
      summary.errors += res.errors;
      for (const e of res.errorDetails) log(`  [error] ${e}`);
    } else {
      // dry-run — still count as "would-write"
      summary.rowsWritten += buffer.length;
    }
    // Checkpoint = max bucket_ts in the just-flushed buffer.
    const maxTs = buffer.reduce(
      (acc, r) => (r.bucket_ts > acc ? r.bucket_ts : acc),
      buffer[0]!.bucket_ts,
    );
    cp.lastCompletedBucketTs = maxTs;
    cp.totalRowsWritten = summary.rowsWritten;
    if (!opts.dryRun) saveCheckpoint(cp);
    buffer.length = 0;
  };

  for await (const candle of deps.adapter.fetchCandles(opts.pair, opts.from, opts.to, { reuseExisting: opts.resume })) {
    summary.rowsParsed++;

    const bucketMs = candle.bucketTs.getTime();
    if (opts.resume && bucketMs <= resumeFromMs) {
      summary.rowsSkippedByCheckpoint++;
      continue;
    }

    const ins = candleToInsert(opts.pair, candle, fetchedAt);
    if (!summary.firstBucket) summary.firstBucket = ins.bucket_ts;
    summary.lastBucket = ins.bucket_ts;
    if (summary.sampleFirst.length < 3) summary.sampleFirst.push(ins);
    summary.sampleLast.push(ins);
    if (summary.sampleLast.length > 3) summary.sampleLast.shift();

    buffer.push(ins);
    if (buffer.length >= BATCH_SIZE) {
      await flush();
    }

    if (summary.rowsParsed % PROGRESS_EVERY === 0) {
      log(`  progress: parsed=${summary.rowsParsed} written=${summary.rowsWritten} at ${ins.bucket_ts}`);
    }
  }

  await flush();
  if (!opts.dryRun) clearCheckpoint(opts.source, opts.pair);

  return summary;
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 4) {
    console.error("usage: backfill <source> <pair> <from-iso-date> <to-iso-date> [--dry-run] [--resume]");
    process.exit(2);
  }
  const [sourceArg, pairArg, fromArg, toArg] = args as [string, string, string, string];
  const dryRun = args.includes("--dry-run");
  const resume = args.includes("--resume");

  if (sourceArg !== "bitstamp" && sourceArg !== "kraken") {
    console.error(`Unknown source '${sourceArg}'. Supported: bitstamp, kraken`);
    process.exit(2);
  }
  const source: SupportedSource = sourceArg;
  const from = new Date(`${fromArg}T00:00:00Z`);
  const to = new Date(`${toArg}T00:00:00Z`);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
    console.error(`Invalid date range: ${fromArg} → ${toArg}`);
    process.exit(2);
  }

  console.log(`[${new Date().toISOString()}] historical-backfill ${source} ${pairArg} ${fromArg} → ${toArg} ${dryRun ? "(DRY-RUN) " : ""}${resume ? "(RESUME) " : ""}`);

  let writer: BatchWriter | null = null;
  if (!dryRun) {
    const env = loadEnv();
    const accessToken = env.ORANGERAILS_PROD_ACCESS_TOKEN;
    const supabaseUrl = env.ORANGERAILS_PROD_SUPABASE_URL;
    if (!accessToken || !supabaseUrl) {
      console.error("ERR: missing ORANGERAILS_PROD_ACCESS_TOKEN / ORANGERAILS_PROD_SUPABASE_URL");
      process.exit(1);
    }
    const m = supabaseUrl.match(/^https:\/\/([a-z0-9]{15,40})\.supabase\.(co|com)/);
    if (!m) {
      console.error("ERR: PROD URL doesn't parse");
      process.exit(1);
    }
    const ctx: DbContext = { projectRef: m[1]!, accessToken };
    writer = new BatchWriter(
      { exec: (sql) => mgmtApiQuery(ctx, sql) },
      { provenance: "historical-backfill" },
    );
  }

  const t0 = Date.now();
  const summary = await runBackfill(
    { source, pair: pairArg, from, to, dryRun, resume },
    { adapter: getAdapter(source), writer },
  );
  const elapsed = Date.now() - t0;

  console.log(`\n--- backfill summary (${elapsed}ms) ---`);
  console.log(`  parsed:                 ${summary.rowsParsed}`);
  console.log(`  ${dryRun ? "would-write" : "written"}:            ${summary.rowsWritten}`);
  console.log(`  skipped-by-checkpoint:  ${summary.rowsSkippedByCheckpoint}`);
  console.log(`  batches:                ${summary.batches}`);
  console.log(`  errors:                 ${summary.errors}`);
  console.log(`  first bucket:           ${summary.firstBucket}`);
  console.log(`  last bucket:            ${summary.lastBucket}`);
  if (summary.sampleFirst.length) {
    console.log(`  sample-first:`);
    for (const r of summary.sampleFirst) {
      console.log(`    ${r.bucket_ts}  rate=${r.rate}  tier=${r.tier}  provider_count=${r.provider_count}`);
    }
  }
  if (summary.sampleLast.length) {
    console.log(`  sample-last:`);
    for (const r of summary.sampleLast) {
      console.log(`    ${r.bucket_ts}  rate=${r.rate}  tier=${r.tier}  provider_count=${r.provider_count}`);
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("historical-backfill FAILED:", err);
    process.exit(1);
  });
}
