/**
 * Full end-to-end live test: real Kraken → resolve → INSERT to Supabase.
 *
 * Reads ORANGERAILS_PROD_* creds from /opt/bb-support/.env.
 * Fetches a recent BTC/USD bucket from Kraken, runs resolve() with Kraken
 * as the single active source, then INSERTs the rate + audit row to PROD.
 * Finally SELECTs the row back to confirm.
 *
 * Run: bun run scripts/live-resolve-and-store.ts
 */

import { readFileSync } from "node:fs";
import { KrakenSource } from "../src/sources/kraken";
import { BitstampSource } from "../src/sources/bitstamp";
import { resolve } from "../src/calculate/resolve";

// --- Load env creds ---
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
    const body = await res.text();
    throw new Error(`Management API ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

async function main() {
  console.log("=== Step 1: resolve a recent BTC/USD bucket from Kraken ===");
  const sources = [new KrakenSource(), new BitstampSource()];
  const effectiveAt = new Date(Date.now() - 3 * 60_000); // 3 minutes ago (ensure candle has closed)
  const result = await resolve({ pair: { source: "BTC", target: "USD" }, effectiveAt }, sources);
  console.log(`  Effective at: ${effectiveAt.toISOString()}`);
  console.log(`  Bucket TS:    ${result.bucketTs.toISOString()}`);
  console.log(`  Rate:         ${result.rate.toFixed(2)}`);
  console.log(`  Tier:         ${result.tier}`);
  console.log(`  Sources:      ${result.audit.providersSucceeded.join(", ")}`);

  console.log("\n=== Step 2: INSERT to exchange_rates on PROD ===");
  const insertRateSql = `
    INSERT INTO exchange_rates (
      source_currency, target_currency, bucket_ts, granularity, product,
      rate, tier, composite, provider_count, status, fetched_at, computed_at
    ) VALUES (
      'BTC', 'USD',
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
  if (!Array.isArray(insertResult) || insertResult.length === 0) {
    throw new Error(`unexpected INSERT response: ${JSON.stringify(insertResult)}`);
  }
  const rateId = insertResult[0]!.id;
  console.log(`  Inserted rate id: ${rateId}`);

  console.log("\n=== Step 3: INSERT audit row to exchange_rate_resolutions ===");
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
  console.log(`  Inserted resolution id: ${auditResult[0]!.id}`);

  console.log("\n=== Step 4: SELECT back to confirm ===");
  const verifySql = `
    SELECT r.id, r.source_currency, r.target_currency, r.bucket_ts,
           r.rate, r.tier, r.provider_count, r.status,
           res.providers_succeeded
    FROM exchange_rates r
    LEFT JOIN exchange_rate_resolutions res ON res.rate_id = r.id
    WHERE r.id = '${rateId}';
  `;
  const verify = (await mgmtApiQuery(verifySql)) as Array<Record<string, unknown>>;
  console.log(`  Row from PROD: ${JSON.stringify(verify[0], null, 2)}`);

  console.log("\n✓ End-to-end PROD write confirmed.");
  console.log(`  ORBI just published its first rate to PROD: BTC/USD = ${result.rate.toFixed(2)} at ${result.bucketTs.toISOString()}`);
}

main().catch((err) => {
  console.error("E2E FAILED:", err);
  process.exit(1);
});
