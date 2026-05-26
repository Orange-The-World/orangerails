/**
 * ORBI gap reconciler — self-healing rate upgrader.
 *
 * Runs 5 minutes behind forward-fill. For each minute in the last 60 minutes
 * where the published rate landed below the achievable tier for that pair,
 * re-attempts the resolve and UPSERTs the upgraded result.
 *
 * Why it exists:
 *   Forward-fill makes one shot at each minute. If a source's API hiccupped,
 *   timed out, or the pair didn't trade in that second, the minute lands with
 *   a lower tier than achievable (e.g., Tier B-single instead of A).
 *   The reconciler re-attempts those minutes using each exchange's historical
 *   candle endpoint and upgrades the row if more sources contribute.
 *
 * Usage:
 *   bun run scripts/reconcile-gaps.ts                # one-shot, writes upgrades
 *   bun run scripts/reconcile-gaps.ts --dry-run      # read-only smoke; logs intent only
 *   bun run scripts/reconcile-gaps.ts --lookback 30  # scan last N minutes (default 60)
 *
 * Operational model:
 *   - Reads exchange_rates rows in the last LOOKBACK_MIN minutes
 *   - For each (target, bucket_ts) below the achievable historical tier,
 *     re-resolves using sources that support historical fetch
 *   - UPSERTs only when the new attempt yields a STRICTLY HIGHER provider_count
 *     (we never downgrade a published rate)
 *   - Idempotent: same minute can be reconciled multiple times safely
 *   - Skips composite pairs (Tier C resolves a different path)
 *
 * Historical-fetch capability per source (documented in plug-in headers):
 *   - kraken:            YES (OHLC?since=)
 *   - bitstamp:          YES (ohlc?start=, last few days)
 *   - bitfinex:          YES (candles/hist?start=&end=)
 *   - coinbase_exchange: YES (candles?start=&end=, last 5 days)
 *   - mercado_bitcoin:   YES (candles?from=&to=)
 *   - bitso:             PARTIAL — pulls last 100 trades; for thin LatAm
 *                        pairs this covers many hours, so historical works
 *                        in practice for the 60-min reconciler window.
 *   - mempool.space:     NO — /api/v1/prices is current-only. The reconciler
 *                        EXCLUDES mempool for past minutes (would otherwise
 *                        stamp current price onto a past bucket).
 *   - frankfurter:       N/A — daily fiat cross-rate, not used for ORBI-M.
 */

import { readFileSync } from "node:fs";
import { KrakenSource } from "../src/sources/kraken";
import { BitstampSource } from "../src/sources/bitstamp";
import { BitfinexSource } from "../src/sources/bitfinex";
import { CoinbaseExchangeSource } from "../src/sources/coinbase-exchange";
import { BitsoSource } from "../src/sources/bitso";
import { MercadoBitcoinSource } from "../src/sources/mercado-bitcoin";
import { resolve as resolveOrchestrator, type ResolveResult } from "../src/calculate/resolve";
import type { Source } from "../src/sources/interface";

// ----------------------------------------------------------------------------
// Env loading — mirrors forward-fill.ts
// ----------------------------------------------------------------------------
function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync("/opt/bb-support/.env", "utf8").split("\n")) {
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
// Tier policy — what's achievable in historical-fetch mode for each pair.
//
// mempool.space cannot fetch past minutes, so the "achievable historical tier"
// for any pair whose primary lift came from mempool is one source lower than
// the live (forward-fill) achievable tier.
// ----------------------------------------------------------------------------
interface PairPolicy {
  /** Target currency. */
  target: string;
  /** Best tier reachable via historical fetch (mempool excluded). */
  maxHistoricalTier: "A" | "B" | "B-single";
  /** Provider count at maxHistoricalTier. Drives upgrade decision. */
  maxHistoricalProviders: number;
  /** Skip entirely — no upgrade ever possible from forward-fill baseline. */
  skip: boolean;
  /** Reason (logged once at startup). */
  reason: string;
}

const PAIR_POLICIES: ReadonlyArray<PairPolicy> = [
  // Tier-A possible: 3+ historical-capable sources
  { target: "USD", maxHistoricalTier: "A", maxHistoricalProviders: 4, skip: false,
    reason: "kraken+bitstamp+bitfinex+coinbase_exchange" },
  { target: "EUR", maxHistoricalTier: "A", maxHistoricalProviders: 3, skip: false,
    reason: "kraken+bitstamp+coinbase_exchange" },
  { target: "GBP", maxHistoricalTier: "A", maxHistoricalProviders: 3, skip: false,
    reason: "kraken+bitstamp+coinbase_exchange" },

  // Tier-B possible: 2 historical-capable sources
  { target: "BRL", maxHistoricalTier: "B", maxHistoricalProviders: 2, skip: false,
    reason: "bitso+mercado_bitcoin" },

  // Single-historical-source pairs: skip (mempool was the second source live,
  // but we can't historically fetch it)
  { target: "CAD", maxHistoricalTier: "B-single", maxHistoricalProviders: 1, skip: true,
    reason: "only kraken supports historical; mempool current-only" },
  { target: "AUD", maxHistoricalTier: "B-single", maxHistoricalProviders: 1, skip: true,
    reason: "only kraken supports historical; mempool current-only" },
  { target: "JPY", maxHistoricalTier: "B-single", maxHistoricalProviders: 1, skip: true,
    reason: "only kraken supports historical; mempool current-only" },
  { target: "CHF", maxHistoricalTier: "B-single", maxHistoricalProviders: 1, skip: true,
    reason: "only kraken supports historical; mempool current-only" },

  // Always-single-source pairs: skip
  { target: "MXN", maxHistoricalTier: "B-single", maxHistoricalProviders: 1, skip: true,
    reason: "bitso-only pair (B-single by design)" },
  { target: "ARS", maxHistoricalTier: "B-single", maxHistoricalProviders: 1, skip: true,
    reason: "bitso-only pair (B-single by design)" },

  // Composite pairs (Tier C): skip — different resolution path
  { target: "INR", maxHistoricalTier: "B-single", maxHistoricalProviders: 1, skip: true,
    reason: "composite via Frankfurter (Tier C); reconciler covers direct only" },
  { target: "TRY", maxHistoricalTier: "B-single", maxHistoricalProviders: 1, skip: true,
    reason: "composite via Frankfurter (Tier C); reconciler covers direct only" },
  { target: "ZAR", maxHistoricalTier: "B-single", maxHistoricalProviders: 1, skip: true,
    reason: "composite via Frankfurter (Tier C); reconciler covers direct only" },
];

const POLICY_BY_TARGET = new Map(PAIR_POLICIES.map((p) => [p.target, p]));

/**
 * Historical-capable sources only. mempool.space deliberately EXCLUDED — its
 * /api/v1/prices is current-only and would corrupt past-minute reconciliation.
 */
function historicalSourcesForTarget(target: string): Source[] {
  const all: Source[] = [
    new KrakenSource(),
    new BitstampSource(),
    new BitfinexSource(),
    new CoinbaseExchangeSource(),
    new BitsoSource(),
    new MercadoBitcoinSource(),
  ];
  return all.filter((s) => s.pairsSupported.includes(`BTC-${target}`));
}

// ----------------------------------------------------------------------------
// PROD Supabase via Management API (mirrors forward-fill pattern)
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

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

// ----------------------------------------------------------------------------
// Candidate scan — find rows below their achievable historical tier
// ----------------------------------------------------------------------------
interface CandidateRow {
  id: string;
  target_currency: string;
  bucket_ts: string;
  tier: string;
  provider_count: number;
}

async function findUpgradeCandidates(
  ctx: DbContext,
  lookbackMinutes: number,
): Promise<CandidateRow[]> {
  const sql = `
    SELECT id, target_currency, bucket_ts::text, tier, provider_count
    FROM exchange_rates
    WHERE status = 'CONFIRMED'
      AND product = 'ORBI-M'
      AND granularity = '1m'
      AND source_currency = 'BTC'
      AND composite = FALSE
      AND bucket_ts >= NOW() - INTERVAL '${lookbackMinutes} minutes'
    ORDER BY bucket_ts ASC, target_currency ASC;
  `;
  return (await mgmtApiQuery(ctx, sql)) as CandidateRow[];
}

// ----------------------------------------------------------------------------
// UPSERT upgrade
// ----------------------------------------------------------------------------
async function upsertUpgrade(
  ctx: DbContext,
  target: string,
  result: ResolveResult,
): Promise<void> {
  const updateSql = `
    INSERT INTO exchange_rates (
      source_currency, target_currency, bucket_ts, granularity, product,
      rate, tier, composite, provider_count, status, fetched_at, computed_at
    ) VALUES (
      'BTC', '${target}',
      '${result.bucketTs.toISOString()}',
      '1m', 'ORBI-M',
      ${result.rate},
      '${result.tier}',
      FALSE,
      ${result.providerCount},
      'CONFIRMED',
      NOW(), NOW()
    )
    ON CONFLICT (source_currency, target_currency, bucket_ts, granularity, product, source_authority)
    DO UPDATE SET
      rate = EXCLUDED.rate,
      tier = EXCLUDED.tier,
      provider_count = EXCLUDED.provider_count,
      computed_at = NOW()
    RETURNING id;
  `;
  const ins = (await mgmtApiQuery(ctx, updateSql)) as Array<{ id: string }>;
  const rateId = ins[0]!.id;

  const responsesJson = JSON.stringify(result.audit.providerResponses);
  const failedJson = JSON.stringify(result.audit.providersFailed);
  const zeroVolJson = JSON.stringify(result.audit.providersZeroVolume);
  const succeededArr = result.audit.providersSucceeded.map((s) => `'${sqlEscape(s)}'`).join(",");

  await mgmtApiQuery(ctx, `
    INSERT INTO exchange_rate_resolutions (
      rate_id, provider_responses, providers_succeeded, providers_failed,
      outliers_discarded, median_calculation, fetched_at
    ) VALUES (
      '${rateId}',
      '${sqlEscape(responsesJson)}'::jsonb,
      ARRAY[${succeededArr || "NULL"}]::text[],
      '${sqlEscape(failedJson)}'::jsonb,
      '${sqlEscape(zeroVolJson)}'::jsonb,
      '${sqlEscape("[reconciler upgrade] " + result.audit.calculationLog)}',
      NOW()
    );
  `);
}

// ----------------------------------------------------------------------------
// Reconciler core (pure-ish, exported for tests)
// ----------------------------------------------------------------------------
export interface ReconcileSummary {
  scanned: number;
  attempted: number;
  upgraded: number;
  unchanged: number;
  failed: number;
  skipped: number;
  details: string[];
}

export interface ReconcileDeps {
  /** Resolve a specific minute against the given sources. Defaults to real orchestrator. */
  resolveFn?: typeof resolveOrchestrator;
  /** Hook for tests — supply a stub source factory. */
  sourcesForTarget?: (target: string) => Source[];
  /** Write hook (skipped in dry-run). */
  writeFn?: (target: string, result: ResolveResult) => Promise<void>;
  /** Capture log lines instead of printing. */
  logSink?: (line: string) => void;
}

/**
 * Inspect candidates and return the ones that COULD be upgraded by
 * historical re-resolve. Exported for unit testing.
 */
export function pickUpgradeCandidates(
  rows: ReadonlyArray<CandidateRow>,
): { candidate: CandidateRow; policy: PairPolicy }[] {
  const out: { candidate: CandidateRow; policy: PairPolicy }[] = [];
  for (const row of rows) {
    const policy = POLICY_BY_TARGET.get(row.target_currency);
    if (!policy) continue;
    if (policy.skip) continue;
    if (row.provider_count >= policy.maxHistoricalProviders) continue;
    out.push({ candidate: row, policy });
  }
  return out;
}

export async function reconcile(
  rows: ReadonlyArray<CandidateRow>,
  opts: { dryRun: boolean } & ReconcileDeps,
): Promise<ReconcileSummary> {
  const log = opts.logSink ?? ((s: string) => console.log(s));
  const sourcesForTarget = opts.sourcesForTarget ?? historicalSourcesForTarget;
  const resolveFn = opts.resolveFn ?? resolveOrchestrator;

  const summary: ReconcileSummary = {
    scanned: rows.length,
    attempted: 0,
    upgraded: 0,
    unchanged: 0,
    failed: 0,
    skipped: 0,
    details: [],
  };

  const targets = pickUpgradeCandidates(rows);
  summary.skipped = rows.length - targets.length;

  for (const { candidate } of targets) {
    summary.attempted++;
    const bucketTs = new Date(candidate.bucket_ts);
    // Resolve at bucket_ts + 90 seconds so the resolve picks the right bucket
    // (matches forward-fill's offset).
    const effectiveAt = new Date(bucketTs.getTime() + 90_000);
    const sources = sourcesForTarget(candidate.target_currency);

    try {
      const result = await resolveFn({ pair: { source: "BTC", target: candidate.target_currency }, effectiveAt }, sources);
      if (result.providerCount > candidate.provider_count) {
        const line = `UPGRADE BTC/${candidate.target_currency} @ ${candidate.bucket_ts}: ` +
          `${candidate.tier}(${candidate.provider_count}) → ${result.tier}(${result.providerCount}) ` +
          `rate=${result.rate.toFixed(2)} [${result.audit.providersSucceeded.join(",")}]`;
        summary.details.push(line);
        log("  " + line);
        if (!opts.dryRun && opts.writeFn) {
          await opts.writeFn(candidate.target_currency, result);
        }
        summary.upgraded++;
      } else {
        summary.unchanged++;
      }
    } catch (err) {
      summary.failed++;
      const msg = err instanceof Error ? err.message.slice(0, 100) : String(err);
      const line = `FAIL BTC/${candidate.target_currency} @ ${candidate.bucket_ts}: ${msg}`;
      summary.details.push(line);
      log("  " + line);
    }
  }

  return summary;
}

// ----------------------------------------------------------------------------
// CLI entrypoint
// ----------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  let lookback = 60;
  const lbIdx = args.indexOf("--lookback");
  if (lbIdx >= 0 && args[lbIdx + 1]) {
    const n = parseInt(args[lbIdx + 1]!, 10);
    if (Number.isFinite(n) && n > 0 && n <= 720) lookback = n;
  }

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

  const t0 = Date.now();
  console.log(`[${new Date().toISOString()}] reconcile-gaps ${dryRun ? "(DRY-RUN) " : ""}lookback=${lookback}min`);

  const rows = await findUpgradeCandidates(ctx, lookback);
  console.log(`  Scanned ${rows.length} rows in last ${lookback} min`);

  const summary = await reconcile(rows, {
    dryRun,
    writeFn: (target, result) => upsertUpgrade(ctx, target, result),
  });

  const elapsed = Date.now() - t0;
  console.log(
    `\n  Summary: scanned=${summary.scanned} attempted=${summary.attempted} ` +
      `upgraded=${summary.upgraded} unchanged=${summary.unchanged} failed=${summary.failed} ` +
      `skipped=${summary.skipped} (${elapsed}ms)`,
  );
  if (dryRun && summary.upgraded > 0) {
    console.log(`  DRY-RUN: ${summary.upgraded} upgrade(s) would have been written.`);
  }
}

// Only run main() when invoked as a script, not when imported by tests.
if (import.meta.main) {
  main().catch((err) => {
    console.error("reconcile-gaps FAILED:", err);
    process.exit(1);
  });
}
