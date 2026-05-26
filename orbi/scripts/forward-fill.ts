/**
 * ORBI forward-fill cron — publishes a fresh ORBI-M rate every minute for
 * each configured pair. Writes to Orange Rails PROD Supabase.
 *
 * Usage:
 *   bun run scripts/forward-fill.ts                     # runs until killed
 *   bun run scripts/forward-fill.ts --once              # one pass then exit
 *   bun run scripts/forward-fill.ts --pairs USD,EUR,BRL # restrict pairs
 *
 * Operational model:
 *   - Every minute, for each configured pair, fetch + resolve + INSERT
 *   - Failures on individual pairs do NOT stop the loop
 *   - Each iteration logs a single-line status summary
 *   - The script is idempotent via UNIQUE constraint + ON CONFLICT
 */

import { readFileSync } from "node:fs";
import { KrakenSource } from "../src/sources/kraken";
import { BitstampSource } from "../src/sources/bitstamp";
import { BitfinexSource } from "../src/sources/bitfinex";
import { MempoolSpaceSource } from "../src/sources/mempool-space";
import { BitsoSource } from "../src/sources/bitso";
import { MercadoBitcoinSource } from "../src/sources/mercado-bitcoin";
import { FrankfurterSource } from "../src/sources/frankfurter";
import { resolve, type ResolveResult } from "../src/calculate/resolve";
import { resolveComposite, type CompositeResolveResult } from "../src/calculate/resolve-composite";
import type { Source } from "../src/sources/interface";

// --- Env load ---
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

const ACCESS_TOKEN = env.ORANGERAILS_PROD_ACCESS_TOKEN!;
const SUPABASE_URL = env.ORANGERAILS_PROD_SUPABASE_URL!;
const m = SUPABASE_URL.match(/^https:\/\/([a-z0-9]{15,40})\.supabase\.(co|com)/);
if (!m) {
  console.error("ERR: PROD URL doesn't parse");
  process.exit(1);
}
const PROJECT_REF = m[1];

// --- Configured pairs ---

// Direct pairs (resolved via VW-median across sources that quote them)
const DIRECT_PAIRS: ReadonlyArray<{ source: string; target: string }> = [
  { source: "BTC", target: "USD" },
  { source: "BTC", target: "EUR" },
  { source: "BTC", target: "GBP" },
  { source: "BTC", target: "CAD" },
  { source: "BTC", target: "AUD" },
  { source: "BTC", target: "JPY" },
  { source: "BTC", target: "CHF" },
  { source: "BTC", target: "MXN" },
  { source: "BTC", target: "BRL" },
  { source: "BTC", target: "ARS" },
];

// Composite pairs (Tier C via BTC/USD ORBI × USD/X Frankfurter)
const COMPOSITE_PAIRS: ReadonlyArray<{ source: string; target: string }> = [
  { source: "BTC", target: "INR" },
  { source: "BTC", target: "TRY" },
  { source: "BTC", target: "ZAR" },
];

// --- Source instances (shared across iterations for connection reuse) ---
const allBtcSources: Source[] = [
  new KrakenSource(),
  new BitstampSource(),
  new BitfinexSource(),
  new MempoolSpaceSource(),
  new BitsoSource(),
  new MercadoBitcoinSource(),
];
const frankfurter = new FrankfurterSource();

// --- Helpers ---
async function mgmtApiQuery(sql: string): Promise<unknown> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; Orange-Rails-ORBI/1.0)",
      Accept: "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) throw new Error(`Mgmt API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

function sourcesForTarget(target: string): Source[] {
  return allBtcSources.filter((s) => s.pairsSupported.includes(`BTC-${target}`));
}

async function publishDirect(target: string, effectiveAt: Date): Promise<string> {
  const sources = sourcesForTarget(target);
  if (sources.length === 0) {
    return `BTC/${target}: no direct sources`;
  }
  try {
    const result = await resolve({ pair: { source: "BTC", target }, effectiveAt }, sources);
    await writeRate(target, result, false, null);
    return `BTC/${target}: ${result.rate.toFixed(2)} (Tier ${result.tier}, ${result.providerCount}src)`;
  } catch (err) {
    return `BTC/${target}: FAIL — ${(err as Error).message.slice(0, 60)}`;
  }
}

async function publishComposite(target: string, effectiveAt: Date): Promise<string> {
  try {
    const result = await resolveComposite({
      pair: { source: "BTC", target },
      effectiveAt,
      btcSources: allBtcSources.slice(0, 5), // exclude Mercado Bitcoin (no USD)
      crossRateSource: frankfurter,
    });
    await writeCompositeRate(target, result);
    return `BTC/${target}: ${result.rate.toFixed(2)} (Tier C via ECB)`;
  } catch (err) {
    return `BTC/${target}: FAIL composite — ${(err as Error).message.slice(0, 60)}`;
  }
}

async function writeRate(
  target: string,
  result: ResolveResult,
  composite: boolean,
  compositeVia: string | null,
): Promise<void> {
  const insertSql = `
    INSERT INTO exchange_rates (
      source_currency, target_currency, bucket_ts, granularity, product,
      rate, tier, composite, composite_via, provider_count, status, fetched_at, computed_at
    ) VALUES (
      'BTC', '${target}',
      '${result.bucketTs.toISOString()}',
      '1m', 'ORBI-M',
      ${result.rate},
      '${result.tier}',
      ${composite},
      ${compositeVia ? `'${sqlEscape(compositeVia)}'` : "NULL"},
      ${result.providerCount},
      'CONFIRMED',
      NOW(), NOW()
    )
    ON CONFLICT (source_currency, target_currency, bucket_ts, granularity, product)
    DO UPDATE SET rate = EXCLUDED.rate, provider_count = EXCLUDED.provider_count, computed_at = NOW()
    RETURNING id;
  `;
  const ins = (await mgmtApiQuery(insertSql)) as Array<{ id: string }>;
  const rateId = ins[0]!.id;

  const responsesJson = JSON.stringify(result.audit.providerResponses);
  const failedJson = JSON.stringify(result.audit.providersFailed);
  const zeroVolJson = JSON.stringify(result.audit.providersZeroVolume);
  const succeededArr = result.audit.providersSucceeded.map((s) => `'${sqlEscape(s)}'`).join(",");

  await mgmtApiQuery(`
    INSERT INTO exchange_rate_resolutions (
      rate_id, provider_responses, providers_succeeded, providers_failed,
      outliers_discarded, median_calculation, fetched_at
    ) VALUES (
      '${rateId}',
      '${sqlEscape(responsesJson)}'::jsonb,
      ARRAY[${succeededArr || "NULL"}]::text[],
      '${sqlEscape(failedJson)}'::jsonb,
      '${sqlEscape(zeroVolJson)}'::jsonb,
      '${sqlEscape(result.audit.calculationLog)}',
      NOW()
    );
  `);
}

async function writeCompositeRate(target: string, result: CompositeResolveResult): Promise<void> {
  const insertSql = `
    INSERT INTO exchange_rates (
      source_currency, target_currency, bucket_ts, granularity, product,
      rate, tier, composite, composite_via, provider_count, status, fetched_at, computed_at
    ) VALUES (
      'BTC', '${target}',
      '${result.bucketTs.toISOString()}',
      '1m', 'ORBI-M',
      ${result.rate},
      'C-composite',
      TRUE,
      '${sqlEscape(result.compositeVia)}',
      ${result.btcUsd.providerCount},
      'CONFIRMED',
      NOW(), NOW()
    )
    ON CONFLICT (source_currency, target_currency, bucket_ts, granularity, product)
    DO UPDATE SET rate = EXCLUDED.rate, provider_count = EXCLUDED.provider_count, computed_at = NOW()
    RETURNING id;
  `;
  const ins = (await mgmtApiQuery(insertSql)) as Array<{ id: string }>;
  const rateId = ins[0]!.id;

  const responsesJson = JSON.stringify({
    btcUsd: result.btcUsd.audit.providerResponses,
    crossRate: { name: result.audit.crossRateSource, rate: result.crossRate },
  });
  const succeededArr = result.btcUsd.audit.providersSucceeded
    .concat([result.audit.crossRateSource])
    .map((s) => `'${sqlEscape(s)}'`)
    .join(",");

  await mgmtApiQuery(`
    INSERT INTO exchange_rate_resolutions (
      rate_id, provider_responses, providers_succeeded, providers_failed,
      outliers_discarded, median_calculation, fetched_at
    ) VALUES (
      '${rateId}',
      '${sqlEscape(responsesJson)}'::jsonb,
      ARRAY[${succeededArr}]::text[],
      '${sqlEscape(JSON.stringify(result.btcUsd.audit.providersFailed))}'::jsonb,
      '${sqlEscape(JSON.stringify([]))}'::jsonb,
      '${sqlEscape(result.audit.formula + "\\n\\n" + result.btcUsd.audit.calculationLog)}',
      NOW()
    );
  `);
}

// --- One iteration ---
async function runIteration(label: string): Promise<void> {
  const t0 = Date.now();
  const effectiveAt = new Date(Date.now() - 90_000); // 1.5 min back so candles have closed

  console.log(`\n[${new Date().toISOString()}] ${label} — effectiveAt=${effectiveAt.toISOString()}`);

  const summaries: string[] = [];

  // Direct pairs: run in parallel
  const directResults = await Promise.all(
    DIRECT_PAIRS.map((p) => publishDirect(p.target, effectiveAt)),
  );
  summaries.push(...directResults);

  // Composite pairs: sequential to share BTC/USD cache (which is re-resolved per call, but minimal overhead)
  for (const p of COMPOSITE_PAIRS) {
    const s = await publishComposite(p.target, effectiveAt);
    summaries.push(s);
  }

  for (const s of summaries) console.log("  ", s);
  const elapsed = Date.now() - t0;
  console.log(`  → iteration done in ${elapsed}ms`);
}

// --- Main loop ---
async function main() {
  const once = process.argv.includes("--once");

  if (once) {
    await runIteration("one-shot");
    return;
  }

  console.log("Starting ORBI forward-fill loop. Ctrl+C to stop.");
  console.log(`Publishing ${DIRECT_PAIRS.length} direct + ${COMPOSITE_PAIRS.length} composite pairs every minute.`);

  let iteration = 0;
  while (true) {
    iteration++;
    try {
      await runIteration(`iteration #${iteration}`);
    } catch (err) {
      console.error(`Iteration #${iteration} unhandled error:`, err);
    }
    // Sleep until the next minute boundary (give 5s buffer for candles to close)
    const now = Date.now();
    const nextBoundary = (Math.floor(now / 60_000) + 1) * 60_000 + 5_000;
    const sleepMs = nextBoundary - now;
    await new Promise((r) => setTimeout(r, sleepMs));
  }
}

main().catch((err) => {
  console.error("Forward-fill FAILED:", err);
  process.exit(1);
});
