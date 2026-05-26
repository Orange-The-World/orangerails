/**
 * Live composite resolution test.
 *
 * For a target currency that no direct BTC source quotes natively (e.g.,
 * BTC/INR, BTC/TRY, BTC/ZAR), compute:
 *   BTC/X = BTC/USD ORBI × USD/X Frankfurter
 *
 * Usage:
 *   bun run scripts/live-resolve-composite.ts INR
 *   bun run scripts/live-resolve-composite.ts TRY
 *   bun run scripts/live-resolve-composite.ts ZAR
 */

import { readFileSync } from "node:fs";
import { KrakenSource } from "../src/sources/kraken";
import { BitstampSource } from "../src/sources/bitstamp";
import { BitfinexSource } from "../src/sources/bitfinex";
import { MempoolSpaceSource } from "../src/sources/mempool-space";
import { BitsoSource } from "../src/sources/bitso";
import { FrankfurterSource } from "../src/sources/frankfurter";
import { resolveComposite } from "../src/calculate/resolve-composite";

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

async function main() {
  const target = (process.argv[2] ?? "INR").toUpperCase();
  const effectiveAt = new Date(Date.now() - 3 * 60_000);

  console.log(`\n=== Composite resolve: BTC/${target} (Tier C) ===`);
  console.log(`  BTC/${target} = BTC/USD ORBI × USD/${target} Frankfurter`);

  const btcSources = [
    new KrakenSource(),
    new BitstampSource(),
    new BitfinexSource(),
    new MempoolSpaceSource(),
    new BitsoSource(),
  ];
  const crossRateSource = new FrankfurterSource();

  const result = await resolveComposite({
    pair: { source: "BTC", target },
    effectiveAt,
    btcSources,
    crossRateSource,
  });

  console.log(`\n  Bucket TS:       ${result.bucketTs.toISOString()}`);
  console.log(`  BTC/USD ORBI:    $${result.btcUsd.rate.toFixed(2)} (Tier ${result.btcUsd.tier}, ${result.btcUsd.providerCount} sources)`);
  console.log(`  USD/${target} ECB:    ${result.crossRate.toFixed(6)}`);
  console.log(`  BTC/${target}:        ${result.rate.toFixed(2)} ${target}/BTC`);
  console.log(`  Formula:         ${result.audit.formula}`);
  console.log(`  Tier:            ${result.tier}`);

  console.log("\n=== INSERT to PROD ===");
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
    ON CONFLICT (source_currency, target_currency, bucket_ts, granularity, product, source_authority)
    DO UPDATE SET
      rate = EXCLUDED.rate,
      provider_count = EXCLUDED.provider_count,
      computed_at = NOW()
    RETURNING id;
  `;
  const insertResult = (await mgmtApiQuery(insertSql)) as Array<{ id: string }>;
  const rateId = insertResult[0]!.id;
  console.log(`  Rate id: ${rateId}`);

  const responsesJson = JSON.stringify({
    btcUsd: result.btcUsd.audit.providerResponses,
    crossRate: { name: result.audit.crossRateSource, rate: result.crossRate },
  });
  const succeededArr = result.btcUsd.audit.providersSucceeded.concat([result.audit.crossRateSource])
    .map((s) => `'${sqlEscape(s)}'`)
    .join(",");

  const insertResolutionSql = `
    INSERT INTO exchange_rate_resolutions (
      rate_id, provider_responses, providers_succeeded, providers_failed,
      outliers_discarded, median_calculation, fetched_at
    ) VALUES (
      '${rateId}',
      '${sqlEscape(responsesJson)}'::jsonb,
      ARRAY[${succeededArr}],
      '${sqlEscape(JSON.stringify(result.btcUsd.audit.providersFailed))}'::jsonb,
      '${sqlEscape(JSON.stringify([]))}'::jsonb,
      '${sqlEscape(result.audit.formula + "\\n\\n" + result.btcUsd.audit.calculationLog)}',
      NOW()
    )
    RETURNING id;
  `;
  const auditResult = (await mgmtApiQuery(insertResolutionSql)) as Array<{ id: string }>;
  console.log(`  Audit id: ${auditResult[0]!.id}`);

  console.log("\n✓ Composite rate published to PROD.");
  console.log(`  ORBI BTC/${target} = ${result.rate.toFixed(2)} (Tier C composite via ECB)`);
}

main().catch((err) => {
  console.error("E2E FAILED:", err);
  process.exit(1);
});
