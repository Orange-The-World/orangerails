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
import { CoinbaseExchangeSource } from "../src/sources/coinbase-exchange";
import { CoincheckSource } from "../src/sources/coincheck";
import { BitbankSource } from "../src/sources/bitbank";
import { IndependentReserveSource } from "../src/sources/independent-reserve";
import { BtcMarketsSource } from "../src/sources/btc-markets";
import { BtcTurkSource } from "../src/sources/btcturk";
import { ParibuSource } from "../src/sources/paribu";
import { LunoSource } from "../src/sources/luno";
import { ValrSource } from "../src/sources/valr";
import { UpbitSource } from "../src/sources/upbit";
import { BithumbSource } from "../src/sources/bithumb";
import { RipioSource } from "../src/sources/ripio";
import { BtseSource } from "../src/sources/btse";
import { FiriSource } from "../src/sources/firi";
import { BitkubSource } from "../src/sources/bitkub";
import { IndodaxSource } from "../src/sources/indodax";
import { CoinmateSource } from "../src/sources/coinmate";
import { BudaSource } from "../src/sources/buda";
import { FrankfurterSource } from "../src/sources/frankfurter";
import { DbCrossRateSource } from "../src/sources/db-cross";
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

// --- Local PG (bb-support self-hosted) ---
// If ORBI_LOCAL_DB_URL is set, all writes go to local Postgres instead of
// Supabase Mgmt API. This bypasses Cloud's Disk IO Budget bottleneck.
// Local DB lives in the supabase-db container, exposed via orbi-pg-proxy on
// 127.0.0.1:5435. Phase C sync handles pushing the serving subset to Cloud.
const LOCAL_DB_URL = env.ORBI_LOCAL_DB_URL || "";
import { SQL } from "bun";
const localSql = LOCAL_DB_URL ? new SQL(LOCAL_DB_URL) : null;
if (localSql) console.log("forward-fill: writing to LOCAL PG (", LOCAL_DB_URL.split("@")[1], ")");
else console.log("forward-fill: writing to CLOUD Mgmt API (ORBI_LOCAL_DB_URL not set)");

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
  { source: "BTC", target: "TRY" },
  { source: "BTC", target: "ZAR" },
  { source: "BTC", target: "KRW" },
  // Extension batch 2026-05-27 — geographic gap-fill (Asia, Nordics, Pacific).
  // Each pair has at least one verified direct source plus a composite fallback
  // entry below (BTC/SEK is composite-only — no keyless venue lists it).
  { source: "BTC", target: "HKD" }, // BTSE
  { source: "BTC", target: "SGD" }, // Independent Reserve
  { source: "BTC", target: "NOK" }, // Firi
  { source: "BTC", target: "DKK" }, // Firi
  { source: "BTC", target: "NZD" }, // Independent Reserve
  // Extension batch 2026-05-27 — BTC × emerging-market fiat.
  // Each pair has at least one verified direct source plus a composite
  // fallback entry below (PLN/PHP/ILS/AED/SAR/UAH are composite-only — no
  // keyless venue we surveyed lists them with a public market API).
  { source: "BTC", target: "THB" }, // Bitkub
  { source: "BTC", target: "IDR" }, // Indodax
  { source: "BTC", target: "MYR" }, // Luno (Malaysia)
  { source: "BTC", target: "CZK" }, // Coinmate
  { source: "BTC", target: "CLP" }, // Buda
  { source: "BTC", target: "COP" }, // Buda
  { source: "BTC", target: "PEN" }, // Buda
];

// Composite pairs (Tier C via BTC/USD ORBI × USD/X Frankfurter).
// Acts as the fallback when a thin-liquidity direct source returns no candles
// for the minute window. BTC/SEK is COMPOSITE-ONLY (no keyless venue lists it).
type CompositePair = {
  source: string;
  target: string;
  /** Where to fetch the USD/X cross-rate from. Default 'frankfurter'. */
  crossMode?: 'frankfurter' | 'db-cross';
};
const COMPOSITE_PAIRS: ReadonlyArray<CompositePair> = [
  { source: "BTC", target: "INR" },
  { source: "BTC", target: "TRY" },
  { source: "BTC", target: "ZAR" },
  // 2026-05-27 extension batch.
  { source: "BTC", target: "HKD" },
  { source: "BTC", target: "SGD" },
  { source: "BTC", target: "NOK" },
  { source: "BTC", target: "SEK" }, // composite-only — no direct source available
  { source: "BTC", target: "DKK" },
  { source: "BTC", target: "NZD" },
  // 2026-05-27 BTC × emerging-market fiat extension.
  // Composite fallback behind each direct source, plus six composite-only
  // pairs where no keyless venue exposes a direct BTC/fiat market:
  //   PLN — Kraken/Bitstamp delisted PLN spot; Polish exchanges keyless API absent.
  //   PHP — PDAX returns HTTP 403 to non-resident IPs; Coins.ph public ticker
  //         host (api.coins.asia) currently unreachable from our infra.
  //   ILS — Bits of Gold sits behind Cloudflare bot protection.
  //   AED — Rain / BitOasis public market data require auth.
  //   SAR — Rain (sole regulated venue) public market data requires auth.
  //   UAH — Kuna's v3/v4 public tickers no longer keyless; api.kuna.io
  //         returns connection refused from our hosts.
  { source: "BTC", target: "THB" },
  { source: "BTC", target: "IDR" },
  { source: "BTC", target: "MYR" },
  { source: "BTC", target: "CZK" },
  { source: "BTC", target: "PLN" }, // composite-only (no keyless direct venue)
  { source: "BTC", target: "PHP" }, // composite-only
  { source: "BTC", target: "ILS" }, // composite-only
  // 2026-06-08 — OXR-backed cross-rate pairs (closing task #25/#47).
  // Frankfurter does not carry these (or stopped — BGN went 404
  // post-EUR adoption 2026-01-01). USD/X lands daily on bb-support DB via
  // /opt/bb-support/scripts/orbi-oxr-fallback.py with source_authority=OXR,
  // granularity=1d. crossMode="db-cross" reads it instead of HTTP.
  { source: "BTC", target: "KES", crossMode: "db-cross" },
  { source: "BTC", target: "TWD", crossMode: "db-cross" },
  { source: "BTC", target: "PKR", crossMode: "db-cross" },
  { source: "BTC", target: "BGN", crossMode: "db-cross" },
  { source: "BTC", target: "JMD", crossMode: "db-cross" },
  { source: "BTC", target: "KWD", crossMode: "db-cross" },
  { source: "BTC", target: "LBP", crossMode: "db-cross" },
  // NOTE: CLP, COP, PEN are direct-only via Buda; ECB does not publish a
  // USD/{CLP,COP,PEN} fixing through Frankfurter, so no composite fallback
  // is configured (Buda outages mean a missed minute, not a stale-rate row).
  // AED, SAR, UAH have neither a verified keyless direct source nor an ECB
  // cross-rate; they are documented in the PR description as future
  // credential / fetcher asks and intentionally excluded from this batch.
];

// Stablecoin / fiat-peg spot pairs.
// Resolved as DIRECT pairs (VW-median across whichever sources quote each
// pair natively). DO NOT add composite fallback — the entire point of
// tracking stablecoins is to surface peg deviation, which a BTC-cross
// composite would launder away. If no source returns a candle for a
// stablecoin pair, the iteration FAILS for that pair and the loop continues.
//
// Coverage as of 2026-05-27:
//   USDT/USD: Kraken + Bitfinex + Coinbase Exchange (Tier A)
//   USDC/USD: Kraken + Bitfinex (Tier B; Coinbase has no USDC-USD self-pair)
//   DAI/USD:  Bitfinex + Coinbase Exchange register the pair but trading is
//             extremely thin (most recent live trade was 2026-04 as of
//             2026-05-27). Forward-fill is EXPECTED to FAIL most minutes;
//             historical backfill into stress periods (March 2023 SVB,
//             March 2024 DAI float) is where this pair earns its keep.
//   PYUSD/USD: Kraken (intermittent volume) + Coinbase Exchange (B-single most minutes)
//   EURC/EUR:  Kraken (intermittent volume; B-single most minutes)
const STABLECOIN_PAIRS: ReadonlyArray<{ source: string; target: string }> = [
  { source: "USDT", target: "USD" },
  { source: "USDC", target: "USD" },
  { source: "DAI", target: "USD" },
  { source: "PYUSD", target: "USD" },
  { source: "EURC", target: "EUR" },
];

// --- Source instances (shared across iterations for connection reuse) ---
const allBtcSources: Source[] = [
  new KrakenSource(),
  new BitstampSource(),
  new BitfinexSource(),
  new MempoolSpaceSource(),
  new BitsoSource(),
  new CoinbaseExchangeSource(),
  new MercadoBitcoinSource(),
  new CoincheckSource(),
  new BitbankSource(),
  new IndependentReserveSource(),
  new BtcMarketsSource(),
  new BtcTurkSource(),
  new ParibuSource(),
  new LunoSource(),
  new ValrSource(),
  new UpbitSource(),
  new BithumbSource(),
  new RipioSource(),
  new BtseSource(),
  new FiriSource(),
  new BitkubSource(),
  new IndodaxSource(),
  new CoinmateSource(),
  new BudaSource(),
];
const frankfurter = new FrankfurterSource();
// db-cross USD/X source for OXR-backed composites. Only constructed when
// localSql is available (we read from local PG, not Mgmt API). If localSql
// is null, the 7 OXR pairs fall through to a SKIP — never silently swap
// to Frankfurter for a pair we know Frankfurter doesn't carry.
// Freshness: 26h covers the daily OXR sync (04:30 UTC) plus 2h slack.
const OXR_DB_CROSS_FRESHNESS_MS = 26 * 60 * 60 * 1000;
const dbCross = localSql
  ? new DbCrossRateSource(localSql, [
      { target: "KES", authorities: ["OXR"], freshnessMs: OXR_DB_CROSS_FRESHNESS_MS },
      { target: "TWD", authorities: ["OXR"], freshnessMs: OXR_DB_CROSS_FRESHNESS_MS },
      { target: "PKR", authorities: ["OXR"], freshnessMs: OXR_DB_CROSS_FRESHNESS_MS },
      { target: "BGN", authorities: ["OXR"], freshnessMs: OXR_DB_CROSS_FRESHNESS_MS },
      { target: "JMD", authorities: ["OXR"], freshnessMs: OXR_DB_CROSS_FRESHNESS_MS },
      { target: "KWD", authorities: ["OXR"], freshnessMs: OXR_DB_CROSS_FRESHNESS_MS },
      { target: "LBP", authorities: ["OXR"], freshnessMs: OXR_DB_CROSS_FRESHNESS_MS },
    ])
  : null;

// --- Helpers ---
async function mgmtApiQuery(sql: string): Promise<unknown> {
  if (localSql) {
    // Local PG path — Bun.sql returns rows directly as an array.
    const rows = await localSql.unsafe(sql);
    return Array.isArray(rows) ? rows : [];
  }
  // Fallback: Cloud Mgmt API
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

/**
 * Find every configured source that natively quotes the given stablecoin / fiat
 * spot pair (e.g. USDT-USD, EURC-EUR). Reuses the same source instances as
 * the BTC pairs so we share rate-limit cadence per source.
 */
function sourcesForStablecoinPair(source: string, target: string): Source[] {
  const code = `${source}-${target}`;
  return allBtcSources.filter((s) => s.pairsSupported.includes(code));
}

async function publishStablecoin(
  source: string,
  target: string,
  effectiveAt: Date,
): Promise<string> {
  const sources = sourcesForStablecoinPair(source, target);
  if (sources.length === 0) {
    return `${source}/${target}: FAIL — no sources configured`;
  }
  try {
    const result = await resolve({ pair: { source, target }, effectiveAt }, sources);
    // Stablecoin pairs are NEVER composite — the whole point is direct peg
    // observation. writeRate writes source_currency=USDT etc. directly.
    await writeRate(target, result, false, null, source);
    return `${source}/${target}: ${result.rate.toFixed(4)} (Tier ${result.tier}, ${result.providerCount}src)`;
  } catch (err) {
    return `${source}/${target}: FAIL — ${(err as Error).message.slice(0, 80)}`;
  }
}

/**
 * Pairs whose underlying venues are so thin that fall-forward staleness
 * manufactures phantom 1m buckets if we publish a >60s-old candle as if
 * it were a fresh tick. For these pairs, skip the publish when the
 * resolved candle is older than the target minute — wait for a real trade
 * (or the once-a-minute gap-fill batch) to fill the row.
 *
 * Added 2026-06-07 after BTC/COP showed min=max=220,942,298 for ~6
 * consecutive minutes (dashboard top-mover spurious 4-6% jumps). The single
 * Buda trade was being re-emitted to each minute bucket until staleness
 * crossed MAX_STALENESS_MS in resolve.ts.
 */
const STALE_SUPPRESS_PAIRS = new Set(["CLP", "COP", "PEN"]);
/** Threshold above which we treat the resolved rate as "stale" for the target minute. */
const STALE_THRESHOLD_MS = 60_000;

async function publishDirect(target: string, effectiveAt: Date): Promise<string> {
  const sources = sourcesForTarget(target);
  if (sources.length === 0) {
    return `BTC/${target}: no direct sources`;
  }
  try {
    const result = await resolve({ pair: { source: "BTC", target }, effectiveAt }, sources);
    if (STALE_SUPPRESS_PAIRS.has(target) && result.staleMs > STALE_THRESHOLD_MS) {
      return `BTC/${target}: SKIP stale (${(result.staleMs / 1000).toFixed(0)}s old, suppress-on-thin-venue)`;
    }
    await writeRate(target, result, false, null);
    return `BTC/${target}: ${result.rate.toFixed(2)} (Tier ${result.tier}, ${result.providerCount}src${result.staleMs > 0 ? `, stale=${(result.staleMs / 1000).toFixed(0)}s` : ""})`;
  } catch (err) {
    return `BTC/${target}: FAIL — ${(err as Error).message.slice(0, 60)}`;
  }
}

async function publishComposite(
  target: string,
  effectiveAt: Date,
  crossMode: 'frankfurter' | 'db-cross' = 'frankfurter',
): Promise<string> {
  let crossRateSource;
  let viaLabel: string;
  if (crossMode === 'db-cross') {
    if (!dbCross) {
      // db-cross requires localSql; if it's not configured, skip rather than
      // fall back to Frankfurter (which doesn't carry these pairs).
      return `BTC/${target}: SKIP composite — db-cross requested but ORBI_LOCAL_DB_URL not set`;
    }
    crossRateSource = dbCross;
    viaLabel = 'DB (OXR)';
  } else {
    crossRateSource = frankfurter;
    viaLabel = 'ECB';
  }
  try {
    const result = await resolveComposite({
      pair: { source: "BTC", target },
      effectiveAt,
      btcSources: allBtcSources.slice(0, 6), // exclude Mercado Bitcoin (no USD)
      crossRateSource,
    });
    await writeCompositeRate(target, result);
    return `BTC/${target}: ${result.rate.toFixed(2)} (Tier C via ${viaLabel})`;
  } catch (err) {
    const msg = (err as Error).message;
    // db-cross stale/missing rows surface as "no data" from resolveComposite;
    // treat those as a clean SKIP so the loop summary doesn't flag a real fault.
    if (crossMode === 'db-cross' && /stale|no USD|not configured|no data/i.test(msg)) {
      return `BTC/${target}: SKIP composite — ${msg.slice(0, 100)}`;
    }
    return `BTC/${target}: FAIL composite — ${msg.slice(0, 60)}`;
  }
}

async function writeRate(
  target: string,
  result: ResolveResult,
  composite: boolean,
  compositeVia: string | null,
  sourceCurrency: string = "BTC",
): Promise<void> {
  const insertSql = `
    INSERT INTO exchange_rates (
      source_currency, target_currency, bucket_ts, granularity, product,
      rate, tier, composite, composite_via, provider_count, status, fetched_at, computed_at
    ) VALUES (
      '${sqlEscape(sourceCurrency)}', '${target}',
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
    ON CONFLICT (source_currency, target_currency, bucket_ts, granularity, product, source_authority)
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
    ON CONFLICT (source_currency, target_currency, bucket_ts, granularity, product, source_authority)
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

// --- Silent-write blackhole guard ---
// 2026-05-30 incident: an orangerails-dev migration restarted pg-proxy (socat);
// the Bun.SQL TCP connection survived but writes silently never reached PG.
// The writer logged 700+ "success" iterations over 12h 50m with ZERO rows
// landing. No error in journald, no exception in the writer.
//
// Mitigation: at the top of each iteration, verify our own recent writes are
// visible in the DB. If 3 consecutive iterations show 0 recent ORBI rows,
// throw — systemd Restart=on-failure re-establishes the connection.
//
// Warm-up: skip the check for the first 5 iterations (cold-start has no
// recent writes yet by definition). Check window (5m) > iteration cadence
// (~1m), so 3 consecutive zeroes = a real 3-5m write outage, not noise.
//
// The SELECT itself runs with a 2s statement_timeout so a hung connection
// cannot lock up the writer; query errors are NOT treated as blackhole
// evidence (could be a transient pooler blip — the existing error handling
// upstream covers that case).
let writeCheckIter = 0;
let writeCheckConsecutiveDry = 0;

async function checkWriteHealth(): Promise<void> {
  writeCheckIter++;
  if (writeCheckIter <= 5) return; // warm-up

  let recentCount = -1;
  // 2s wall-clock cap on the health query — a hung connection must not lock
  // up the writer. Promise.race is tool-agnostic; works for both Bun.SQL and
  // fetch paths.
  const timeoutP = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error("health-check timeout (5s)")), 5_000),
  );
  try {
    if (localSql) {
      const queryP = localSql.unsafe(
        `SELECT COUNT(*)::int AS n FROM exchange_rates WHERE fetched_at > NOW() - INTERVAL '5 minutes' AND source_authority = 'ORBI' AND provenance = 'forward-fill'`,
      );
      const rows = (await Promise.race([queryP, timeoutP])) as unknown;
      const arr = Array.isArray(rows) ? rows : [];
      const row = arr[0] as { n?: number } | undefined;
      recentCount = typeof row?.n === "number" ? row.n : -1;
    } else {
      // Cloud Mgmt API path — no statement_timeout knob; rely on fetch timeout.
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 5_000);
      try {
        const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
          method: "POST",
          signal: ac.signal,
          headers: {
            Authorization: `Bearer ${ACCESS_TOKEN}`,
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (compatible; Orange-Rails-ORBI/1.0)",
            Accept: "application/json",
          },
          body: JSON.stringify({
            query: `SELECT COUNT(*)::int AS n FROM exchange_rates WHERE fetched_at > NOW() - INTERVAL '5 minutes' AND source_authority = 'ORBI' AND provenance = 'forward-fill'`,
          }),
        });
        if (res.ok) {
          const j = (await res.json()) as Array<{ n?: number }>;
          recentCount = typeof j?.[0]?.n === "number" ? j[0]!.n! : -1;
        }
      } finally {
        clearTimeout(to);
      }
    }
  } catch (err) {
    // Query errors are NOT blackhole evidence — don't trip the guard.
    console.warn(
      `  write-health check query failed (not counted): ${(err as Error).message.slice(0, 120)}`,
    );
    return;
  }

  if (recentCount < 0) return; // could not determine — don't trip

  if (recentCount > 0) {
    writeCheckConsecutiveDry = 0;
    return;
  }

  writeCheckConsecutiveDry++;
  console.warn(
    `  write-health: 0 recent ORBI rows in last 5m (consecutive_dry=${writeCheckConsecutiveDry}/3)`,
  );
  if (writeCheckConsecutiveDry >= 3) {
    // 2026-06-09: main() loop has a try/catch that swallowed the throw, so
    // the service stayed alive while logging the error 21x. Exit hard so
    // systemd Restart=on-failure fires and re-establishes the connection.
    const msg = `Silent write blackhole detected — ${writeCheckConsecutiveDry} consecutive iterations with 0 recent ORBI rows in DB`;
    console.error(`FATAL: ${msg} — exiting for systemd restart`);
    process.exit(1);
  }
}

// --- One iteration ---
// effectiveAtOverride: if provided, use this minute bucket; otherwise derive
// from clock (now - 90s). Catch-up loop in main() passes explicit minutes.
async function runIteration(label: string, effectiveAtOverride?: Date): Promise<void> {
  await checkWriteHealth();
  const t0 = Date.now();
  // --at <iso> overrides effectiveAt for gap-fill of past minutes
  const atArg = process.argv.find((a, i) => process.argv[i-1] === "--at");
  const effectiveAt = effectiveAtOverride ?? (atArg ? new Date(atArg) : new Date(Date.now() - 90_000));

  console.log(`\n[${new Date().toISOString()}] ${label} — effectiveAt=${effectiveAt.toISOString()}`);

  const summaries: string[] = [];

  // Direct pairs: run in parallel
  const directResults = await Promise.all(
    DIRECT_PAIRS.map((p) => publishDirect(p.target, effectiveAt)),
  );
  summaries.push(...directResults);

  // Stablecoin / fiat-peg pairs: run in parallel; never composite.
  const stableResults = await Promise.all(
    STABLECOIN_PAIRS.map((p) => publishStablecoin(p.source, p.target, effectiveAt)),
  );
  summaries.push(...stableResults);

  // Composite pairs: parallel (BTC/USD is re-resolved per pair but the
  // overhead is dominated by network I/O on the cross-rate fetch, which
  // benefits massively from concurrency). Pre-fix: 15 sequential calls cost
  // ~45s and starved the loop of a full minute. Post-fix: ~3-5s.
  const compositeResults = await Promise.all(
    COMPOSITE_PAIRS.map((p) => publishComposite(p.target, effectiveAt, p.crossMode ?? 'frankfurter')),
  );
  summaries.push(...compositeResults);

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
  console.log(`Publishing ${DIRECT_PAIRS.length} direct + ${STABLECOIN_PAIRS.length} stablecoin + ${COMPOSITE_PAIRS.length} composite pairs every minute.`);

  // Track the last minute bucket we have published. Each loop turn computes
  // the target bucket (now - 90s, floored to the minute) and publishes EVERY
  // missed bucket between lastPublished+1m and target. This guarantees
  // density even when iterations occasionally run > 60s (writer contention,
  // upstream slowness, etc.) — pre-fix the loop slept to the next minute
  // boundary regardless and silently skipped buckets, producing the 60-95%
  // density the Coverage Validation Matrix flagged on 2026-05-29.
  let iteration = 0;
  let lastPublishedMs: number | null = null;
  while (true) {
    const now = Date.now();
    // Target bucket: floor((now - 90s) / 60s) * 60s — the most recent minute
    // whose candles have had at least 30s to close on upstream venues.
    const targetMs = Math.floor((now - 90_000) / 60_000) * 60_000;

    // First boot: only publish the current target minute (don't backfill
    // from cold-start — gap-fill jobs own that).
    if (lastPublishedMs === null) lastPublishedMs = targetMs - 60_000;

    // Catch up every missed minute between lastPublished+1m and target.
    while (lastPublishedMs < targetMs) {
      const bucketMs = lastPublishedMs + 60_000;
      iteration++;
      try {
        await runIteration(`iteration #${iteration}`, new Date(bucketMs));
        lastPublishedMs = bucketMs;
      } catch (err) {
        console.error(`Iteration #${iteration} unhandled error:`, err);
        // On unhandled error, still advance the watermark to avoid an
        // infinite tight loop on a poisoned minute.
        lastPublishedMs = bucketMs;
      }
    }

    // If we caught up to target, wait until the NEXT minute is eligible
    // (target + 60s + 90s buffer past wall clock).
    const nextTargetWallMs = lastPublishedMs + 60_000 + 90_000;
    const sleepMs = Math.max(1_000, nextTargetWallMs - Date.now());
    await new Promise((r) => setTimeout(r, sleepMs));
  }
}

main().catch((err) => {
  console.error("Forward-fill FAILED:", err);
  process.exit(1);
});
