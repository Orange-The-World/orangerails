/**
 * Central-bank backfill orchestrator.
 *
 * CLI:
 *   bun run scripts/central-banks/orchestrator.ts banxico 1993-01-01 2026-05-26 --dry-run
 *   bun run scripts/central-banks/orchestrator.ts bcb    1999-01-01 2026-05-26 --dry-run
 *   bun run scripts/central-banks/orchestrator.ts boc    2017-01-01 2026-05-26 --dry-run
 *
 * Pipeline:
 *   1. Load env from /opt/bb-support/.env (BANXICO_API_TOKEN required for
 *      Banxico; BCB and BoC are unauthenticated).
 *   2. Fetch the full date range in one or two API calls (these are daily
 *      series; a single response easily covers decades).
 *   3. Map to AuthorityRateInsert rows (source_authority = BANXICO/BCB/BOC,
 *      product = 'ORBI-D-authority', tier = 'B-single').
 *   4. In --dry-run, print row counts + sample first/last rows, never call
 *      the Management API.
 *   5. In live mode, UPSERT via AuthorityBatchWriter into exchange_rates.
 *
 * Reuses orbi/scripts/historical-backfill/lib/checkpoint.ts for
 * resumable progress tracking. Because each authority's full backfill is
 * a single API call + at most thousands of rows, the checkpoint mostly
 * matters for the live-write phase, not the download phase.
 *
 * PROD writes require explicit founder approval and migration 006 applied.
 */

import { existsSync, readFileSync } from "node:fs";
import { BanxicoSource } from "./sources/banxico";
import { BcbSource } from "./sources/bcb";
import { BankOfCanadaSource } from "./sources/bank-of-canada";
import {
  AuthorityBatchWriter,
  type AuthorityRateInsert,
} from "./lib/batch-writer";
import {
  clearCheckpoint,
  loadCheckpoint,
  newCheckpoint,
  saveCheckpoint,
  type Checkpoint,
} from "../historical-backfill/lib/checkpoint";

const BATCH_SIZE = 500;

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
// Supabase Management API executor
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
// Authority pipelines
// ----------------------------------------------------------------------------
type AuthorityKey = "banxico" | "bcb" | "boc";

async function fetchRowsForAuthority(
  authority: AuthorityKey,
  from: string,
  to: string,
  env: Record<string, string>,
  fetchedAtIso: string,
): Promise<AuthorityRateInsert[]> {
  switch (authority) {
    case "banxico": {
      const src = new BanxicoSource();
      const raw = await src.fetch({ from, to, token: env.BANXICO_API_TOKEN ?? "" });
      return src.toInserts(raw, fetchedAtIso);
    }
    case "bcb": {
      const src = new BcbSource();
      const raw = await src.fetch({ from, to });
      return src.toInserts(raw, fetchedAtIso);
    }
    case "boc": {
      const src = new BankOfCanadaSource();
      const raw = await src.fetch({ from, to });
      return src.toInserts(raw, fetchedAtIso);
    }
  }
}

function pairLabel(authority: AuthorityKey): string {
  switch (authority) {
    case "banxico": return "USD/MXN";
    case "bcb":     return "USD/BRL";
    case "boc":     return "USD/CAD";
  }
}

// ----------------------------------------------------------------------------
// Core (exported for tests)
// ----------------------------------------------------------------------------
export interface CbBackfillOptions {
  authority: AuthorityKey;
  from: string;
  to: string;
  dryRun: boolean;
  resume: boolean;
}

export interface CbBackfillSummary {
  rowsParsed: number;
  rowsWritten: number;
  rowsSkippedByCheckpoint: number;
  batches: number;
  errors: number;
  firstBucket: string | null;
  lastBucket: string | null;
  sampleFirst: AuthorityRateInsert[];
  sampleLast: AuthorityRateInsert[];
}

export interface CbBackfillDeps {
  fetchRows: () => Promise<AuthorityRateInsert[]>;
  writer: AuthorityBatchWriter | null;
  log?: (msg: string) => void;
}

export async function runCbBackfill(
  opts: CbBackfillOptions,
  deps: CbBackfillDeps,
): Promise<CbBackfillSummary> {
  const log = deps.log ?? ((s: string) => console.log(s));
  const summary: CbBackfillSummary = {
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

  const cpKey = pairLabel(opts.authority);
  let cp: Checkpoint = opts.resume
    ? loadCheckpoint(opts.authority, cpKey) ?? newCheckpoint(opts.authority, cpKey)
    : newCheckpoint(opts.authority, cpKey);
  const resumeFromMs = cp.lastCompletedBucketTs
    ? new Date(cp.lastCompletedBucketTs).getTime()
    : -1;

  const allRows = await deps.fetchRows();
  log(`  [${opts.authority}] fetched ${allRows.length} observations from upstream`);

  const rows = allRows.filter((r) => {
    summary.rowsParsed++;
    if (opts.resume && new Date(r.bucket_ts).getTime() <= resumeFromMs) {
      summary.rowsSkippedByCheckpoint++;
      return false;
    }
    return true;
  });

  if (rows.length === 0) {
    log(`  [${opts.authority}] nothing to write after resume/filter.`);
    return summary;
  }

  summary.firstBucket = rows[0]!.bucket_ts;
  summary.lastBucket = rows[rows.length - 1]!.bucket_ts;
  summary.sampleFirst = rows.slice(0, 3);
  summary.sampleLast = rows.slice(-3);

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    summary.batches++;
    if (deps.writer) {
      const res = await deps.writer.write(chunk);
      summary.rowsWritten += res.written;
      summary.errors += res.errors;
      for (const e of res.errorDetails) log(`  [error] ${e}`);
    } else {
      summary.rowsWritten += chunk.length; // would-write
    }
    const maxTs = chunk.reduce((a, r) => (r.bucket_ts > a ? r.bucket_ts : a), chunk[0]!.bucket_ts);
    cp.lastCompletedBucketTs = maxTs;
    cp.totalRowsWritten = summary.rowsWritten;
    if (!opts.dryRun) saveCheckpoint(cp);
  }

  if (!opts.dryRun) clearCheckpoint(opts.authority, cpKey);
  return summary;
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error("usage: cb-backfill <authority: banxico|bcb|boc> <from YYYY-MM-DD> <to YYYY-MM-DD> [--dry-run] [--resume]");
    process.exit(2);
  }
  const [authorityArg, fromArg, toArg] = args as [string, string, string];
  const dryRun = args.includes("--dry-run");
  const resume = args.includes("--resume");

  if (!["banxico", "bcb", "boc"].includes(authorityArg)) {
    console.error(`Unknown authority: ${authorityArg}. Supported: banxico, bcb, boc.`);
    process.exit(2);
  }
  const authority = authorityArg as AuthorityKey;

  for (const d of [fromArg, toArg]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      console.error(`Date must be YYYY-MM-DD; got: ${d}`);
      process.exit(2);
    }
  }
  if (fromArg >= toArg) {
    console.error(`Invalid date range: ${fromArg} → ${toArg}`);
    process.exit(2);
  }

  console.log(`[${new Date().toISOString()}] cb-backfill ${authority} ${fromArg} → ${toArg} ${dryRun ? "(DRY-RUN) " : ""}${resume ? "(RESUME) " : ""}`);

  const env = loadEnv();
  const fetchedAtIso = new Date().toISOString();

  let writer: AuthorityBatchWriter | null = null;
  if (!dryRun) {
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
    writer = new AuthorityBatchWriter({ exec: (sql) => mgmtApiQuery(ctx, sql) });
  }

  const t0 = Date.now();
  const summary = await runCbBackfill(
    { authority, from: fromArg, to: toArg, dryRun, resume },
    {
      fetchRows: () => fetchRowsForAuthority(authority, fromArg, toArg, env, fetchedAtIso),
      writer,
    },
  );
  const elapsed = Date.now() - t0;

  console.log(`\n--- cb-backfill summary (${elapsed}ms) ---`);
  console.log(`  authority:              ${authority}`);
  console.log(`  pair:                   ${pairLabel(authority)}`);
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
      console.log(`    ${r.bucket_ts}  ${r.source_currency}/${r.target_currency}  rate=${r.rate}  authority=${r.source_authority}`);
    }
  }
  if (summary.sampleLast.length) {
    console.log(`  sample-last:`);
    for (const r of summary.sampleLast) {
      console.log(`    ${r.bucket_ts}  ${r.source_currency}/${r.target_currency}  rate=${r.rate}  authority=${r.source_authority}`);
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("cb-backfill FAILED:", err);
    process.exit(1);
  });
}
