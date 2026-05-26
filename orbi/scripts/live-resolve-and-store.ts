/**
 * Full end-to-end live test: real exchange APIs → resolve → INSERT to PROD.
 *
 * Reads ORANGERAILS_PROD_* creds from /opt/bb-support/.env.
 * Takes optional CLI arg for target currency (default: USD).
 *
 * Usage:
 *   bun run scripts/live-resolve-and-store.ts          → BTC/USD all-sources
 *   bun run scripts/live-resolve-and-store.ts BRL      → BTC/BRL via LatAm panel
 *   bun run scripts/live-resolve-and-store.ts MXN      → BTC/MXN via Bitso single
 */

import { readFileSync } from "node:fs";
import { KrakenSource } from "../src/sources/kraken";
import { BitstampSource } from "../src/sources/bitstamp";
import { BitfinexSource } from "../src/sources/bitfinex";
import { MempoolSpaceSource } from "../src/sources/mempool-space";
import { BitsoSource } from "../src/sources/bitso";
import { MercadoBitcoinSource } from "../src/sources/mercado-bitcoin";
import { resolve } from "../src/calculate/resolve";
import type { Source } from "../src/sources/interface";

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
  if (!res.ok) {
    throw new Error(`Management API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

/** Pick the set of sources that natively quote BTC↔target. */
function sourcesForTarget(target: string): Source[] {
  const allSources: Source[] = [
    new KrakenSource(),
    new BitstampSource(),
    new BitfinexSource(),
    new MempoolSpaceSource(),
    new BitsoSource(),
    new MercadoBitcoinSource(),
  ];
  return allSources.filter((s) => s.pairsSupported.includes(`BTC-${target}`));
}

async function main() {
  const target = (process.argv[2] ?? "USD").toUpperCase();
  const sources = sourcesForTarget(target);

  console.log(`\n=== Live resolve: BTC/${target} (${sources.length} sources) ===`);
  if (sources.length === 0) {
    console.error(`No active sources quote BTC/${target} natively. Composite via Frankfurter not yet implemented.`);
    process.exit(1);
  }
  console.log(`  Sources: ${sources.map((s) => s.name).join(", ")}`);

  const effectiveAt = new Date(Date.now() - 3 * 60_000);
  const result = await resolve({ pair: { source: "BTC", target }, effectiveAt }, sources);

  console.log(`\n  Bucket TS:   ${result.bucketTs.toISOString()}`);
  console.log(`  Rate:        ${result.rate.toFixed(2)} ${target}/BTC`);
  console.log(`  Tier:        ${result.tier}`);
  console.log(`  Contributed: ${result.audit.providersSucceeded.join(", ")}`);
  if (result.audit.providersFailed.length > 0) {
    console.log(`  Failed:      ${result.audit.providersFailed.map((p) => `${p.name}(${p.reason})`).join(", ")}`);
  }

  console.log("\n=== INSERT to PROD ===");
  const insertRateSql = `
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
    ON CONFLICT (source_currency, target_currency, bucket_ts, granularity, product)
    DO UPDATE SET
      rate = EXCLUDED.rate,
      provider_count = EXCLUDED.provider_count,
      computed_at = NOW()
    RETURNING id;
  `;
  const insertResult = (await mgmtApiQuery(insertRateSql)) as Array<{ id: string }>;
  const rateId = insertResult[0]!.id;
  console.log(`  Rate id: ${rateId}`);

  const responsesJson = JSON.stringify(result.audit.providerResponses);
  const failedJson = JSON.stringify(result.audit.providersFailed);
  const zeroVolJson = JSON.stringify(result.audit.providersZeroVolume);
  const succeededArr = result.audit.providersSucceeded.map((s) => `'${sqlEscape(s)}'`).join(",");

  const insertResolutionSql = `
    INSERT INTO exchange_rate_resolutions (
      rate_id, provider_responses, providers_succeeded, providers_failed,
      outliers_discarded, median_calculation, fetched_at
    ) VALUES (
      '${rateId}',
      '${sqlEscape(responsesJson)}'::jsonb,
      ARRAY[${succeededArr}],
      '${sqlEscape(failedJson)}'::jsonb,
      '${sqlEscape(zeroVolJson)}'::jsonb,
      '${sqlEscape(result.audit.calculationLog)}',
      NOW()
    )
    RETURNING id;
  `;
  const auditResult = (await mgmtApiQuery(insertResolutionSql)) as Array<{ id: string }>;
  console.log(`  Audit id: ${auditResult[0]!.id}`);

  console.log("\n✓ Published to PROD.");
  console.log(`  ORBI BTC/${target} = ${result.rate.toFixed(2)} (Tier ${result.tier}, ${result.providerCount} sources)`);
}

main().catch((err) => {
  console.error("E2E FAILED:", err);
  process.exit(1);
});
