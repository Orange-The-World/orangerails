/**
 * ORBI client — drop-in module for any Supabase-aware app (V3, OWM, OWB,
 * future Tier-3 partners). Reads CONFIRMED rates from the Orange Rails PROD
 * `exchange_rates` table via the OR PROD anon key.
 *
 * RLS is enforced — this client can ONLY read. Writes are blocked at the DB
 * layer. The anon key is safe to ship to a client/browser bundle.
 *
 * Environment variables expected:
 *   ORBI_SUPABASE_URL         — Orange Rails PROD Supabase URL
 *   ORBI_SUPABASE_ANON_KEY    — Orange Rails PROD anon key (gated by RLS)
 *
 * For Vite/React apps prefix as `VITE_ORBI_SUPABASE_URL` etc.; for Node.js
 * apps use process.env. The helper below tries both.
 *
 * Usage:
 *
 *   import { fetchORBIM, fetchLatestORBIM } from '@orange-rails/rates-client';
 *
 *   // Price a transaction at a specific timestamp
 *   const rate = await fetchORBIM('BTC', 'USD', new Date('2026-03-14T14:35:21Z'));
 *   if (rate) {
 *     const usdValue = btcAmount * rate.rate;
 *   }
 *
 *   // Get latest published rate (e.g., for a UI ticker)
 *   const latest = await fetchLatestORBIM('BTC', 'USD');
 *
 * Open audit URL with `https://wiki.abascal.ca/doc/orbi-data-status-tables-explained-hDgmMFLT6v`
 * for any rate's audit trail by joining to exchange_rate_resolutions on rate.id.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ---- Types ----

export type ORBITier = "A" | "B" | "B-single" | "C-composite" | "stable";

export interface ORBIRate {
  /** Unique rate ID — use this to look up the audit row */
  id: string;
  /** The published price */
  rate: number;
  /** Reliability tier (A = multi-source, B = 1-2 sources, C-composite = via cross-rate) */
  tier: ORBITier;
  /** Start of the 1-minute window this rate covers (UTC ISO string) */
  bucketTs: string;
  /** How many sources contributed to the median */
  providerCount: number;
  /** True if computed as BTC↔USD ORBI × USD↔X cross-rate */
  composite: boolean;
  /** If composite, the formula identifier (e.g. "BTC-USD * USD-MXN") */
  compositeVia: string | null;
}

export interface ORBIAuditEntry {
  /** Sources whose candles contributed to the median */
  providersSucceeded: string[];
  /** Sources that failed and why */
  providersFailed: Array<{ name: string; reason: string }>;
  /** Sources whose candles had zero volume (dropped from median) */
  providersZeroVolume: string[];
  /** Human-readable cumulative-volume walk */
  medianCalculation: string;
  /** Full provider responses as JSON */
  providerResponses: Record<string, unknown>;
}

// ---- Client singleton ----

let orbiClient: SupabaseClient | null = null;

interface ORBIConfig {
  url?: string;
  anonKey?: string;
}

/**
 * Initialize the ORBI client. Call once at app startup, or rely on
 * environment-variable auto-detection.
 */
export function initORBIClient(config?: ORBIConfig): SupabaseClient {
  if (orbiClient && !config) return orbiClient;

  const url = config?.url ?? resolveEnv("ORBI_SUPABASE_URL");
  const key = config?.anonKey ?? resolveEnv("ORBI_SUPABASE_ANON_KEY");

  if (!url || !key) {
    throw new Error(
      "ORBI client: missing ORBI_SUPABASE_URL or ORBI_SUPABASE_ANON_KEY. " +
        "Set as env vars (Node) or VITE_-prefixed env vars (Vite/React).",
    );
  }

  orbiClient = createClient(url, key, {
    auth: { persistSession: false },
    global: { headers: { "x-orbi-client": "rates-client/0.1.0" } },
  });

  return orbiClient;
}

function resolveEnv(name: string): string | undefined {
  // Node.js path
  if (typeof process !== "undefined" && process.env) {
    const v = process.env[name];
    if (v) return v;
  }
  // Vite path (browser)
  if (typeof import.meta !== "undefined") {
    const meta = import.meta as unknown as { env?: Record<string, string> };
    if (meta.env) {
      const v = meta.env[`VITE_${name}`];
      if (v) return v;
    }
  }
  return undefined;
}

// ---- Public API ----

/**
 * Fetch ORBI-M (per-minute) rate for the given pair at the given timestamp.
 * Returns null if no rate is published yet for that bucket.
 *
 * The bucket is determined by flooring effectiveAt to the previous full
 * minute boundary, per methodology §3.2 (e.g., 14:35:21 → 14:34:00 bucket).
 */
export async function fetchORBIM(
  sourceCurrency: string,
  targetCurrency: string,
  effectiveAt: Date,
): Promise<ORBIRate | null> {
  const client = initORBIClient();

  // Floor to the prior full minute boundary
  const minuteFloor = Math.floor(effectiveAt.getTime() / 60_000) * 60_000;
  const bucketMs = minuteFloor - 60_000;
  const bucketTsIso = new Date(bucketMs).toISOString();

  const { data, error } = await client
    .from("exchange_rates")
    .select("id, rate, tier, bucket_ts, provider_count, composite, composite_via")
    .eq("source_currency", sourceCurrency)
    .eq("target_currency", targetCurrency)
    .eq("product", "ORBI-M")
    .eq("granularity", "1m")
    .eq("status", "CONFIRMED")
    .eq("bucket_ts", bucketTsIso)
    .maybeSingle();

  if (error) throw new Error(`ORBI fetch failed: ${error.message}`);
  if (!data) return null;

  return mapRow(data);
}

/**
 * Fetch the most recent published ORBI-M rate for the pair (handy for
 * "current price" displays). Returns null if no rates exist yet.
 */
export async function fetchLatestORBIM(
  sourceCurrency: string,
  targetCurrency: string,
): Promise<ORBIRate | null> {
  const client = initORBIClient();

  const { data, error } = await client
    .from("exchange_rates")
    .select("id, rate, tier, bucket_ts, provider_count, composite, composite_via")
    .eq("source_currency", sourceCurrency)
    .eq("target_currency", targetCurrency)
    .eq("product", "ORBI-M")
    .eq("granularity", "1m")
    .eq("status", "CONFIRMED")
    .order("bucket_ts", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`ORBI fetch failed: ${error.message}`);
  if (!data) return null;

  return mapRow(data);
}

/**
 * Fetch the audit entry for a given rate ID. Use this for transparency UIs
 * ("show the input candles that produced this rate").
 */
export async function fetchAuditEntry(rateId: string): Promise<ORBIAuditEntry | null> {
  const client = initORBIClient();
  const { data, error } = await client
    .from("exchange_rate_resolutions")
    .select(
      "provider_responses, providers_succeeded, providers_failed, outliers_discarded, median_calculation",
    )
    .eq("rate_id", rateId)
    .maybeSingle();

  if (error) throw new Error(`ORBI audit fetch failed: ${error.message}`);
  if (!data) return null;

  return {
    providersSucceeded: (data.providers_succeeded as string[]) ?? [],
    providersFailed: (data.providers_failed as Array<{ name: string; reason: string }>) ?? [],
    providersZeroVolume: (data.outliers_discarded as string[]) ?? [],
    medianCalculation: (data.median_calculation as string) ?? "",
    providerResponses: (data.provider_responses as Record<string, unknown>) ?? {},
  };
}

/**
 * Fetch ORBI-M rates over a time range. Useful for historical reports.
 * Returns rates sorted ascending by bucket_ts.
 */
export async function fetchORBIMRange(
  sourceCurrency: string,
  targetCurrency: string,
  from: Date,
  to: Date,
): Promise<ORBIRate[]> {
  const client = initORBIClient();

  const { data, error } = await client
    .from("exchange_rates")
    .select("id, rate, tier, bucket_ts, provider_count, composite, composite_via")
    .eq("source_currency", sourceCurrency)
    .eq("target_currency", targetCurrency)
    .eq("product", "ORBI-M")
    .eq("granularity", "1m")
    .eq("status", "CONFIRMED")
    .gte("bucket_ts", from.toISOString())
    .lte("bucket_ts", to.toISOString())
    .order("bucket_ts", { ascending: true });

  if (error) throw new Error(`ORBI range fetch failed: ${error.message}`);
  return (data ?? []).map(mapRow);
}

/**
 * Health probe — verifies the ORBI client can reach the database and the
 * anon key is valid. Returns { reachable, latestRateAt }.
 */
export async function orbiHealthCheck(): Promise<{
  reachable: boolean;
  latestRateAt: Date | null;
  error?: string;
}> {
  try {
    const latest = await fetchLatestORBIM("BTC", "USD");
    return {
      reachable: true,
      latestRateAt: latest ? new Date(latest.bucketTs) : null,
    };
  } catch (err) {
    return {
      reachable: false,
      latestRateAt: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---- Internal helpers ----

function mapRow(row: {
  id: string;
  rate: number | string;
  tier: string;
  bucket_ts: string;
  provider_count: number;
  composite: boolean;
  composite_via: string | null;
}): ORBIRate {
  return {
    id: row.id,
    rate: typeof row.rate === "string" ? Number(row.rate) : row.rate,
    tier: row.tier as ORBITier,
    bucketTs: row.bucket_ts,
    providerCount: row.provider_count,
    composite: row.composite,
    compositeVia: row.composite_via,
  };
}
// (Appended) — on-demand resolve fallback
// --------------------------------------------------------------------------
// Adds a function that first tries the direct DB query (same as fetchORBIM)
// and, on cache miss, calls the on-demand-resolve Edge Function which will
// compute + cache the rate and return it. Use this in flows where minute
// precision matters and forward-fill may not have covered the minute yet.

/**
 * Shape mirroring V3's existing rate-resolver. The Edge Function returns
 * exactly this; we wrap fetchORBIM's ORBIRate into the same shape for parity.
 */
export interface PinnedRateResult {
  rate: number;
  rateId: string;
  bucketTs: string;
  bucketGranularity: "M" | "D";
  provider: string;
  sourceKind: "CRYPTO_FIAT";
  pending: false;
  stale: boolean;
  computedOnDemand: boolean;
}

/**
 * Get a rate for a specific minute. If the rate exists in PROD, return it
 * immediately (computedOnDemand=false). If not, call the on-demand-resolve
 * Edge Function to fetch it from upstream sources, store it, and return
 * (computedOnDemand=true). Either path returns the same shape.
 *
 * Use this for historical transactions where you need minute precision
 * and forward-fill may not have covered that minute.
 */
export async function getOrResolveRate(
  sourceCurrency: string,
  targetCurrency: string,
  effectiveAt: Date,
): Promise<PinnedRateResult | null> {
  // 1) Try direct DB query first — same path as fetchORBIM.
  const cached = await fetchORBIM(sourceCurrency, targetCurrency, effectiveAt);
  if (cached) {
    return {
      rate: cached.rate,
      rateId: cached.id,
      bucketTs: cached.bucketTs,
      bucketGranularity: "M",
      provider: cached.composite
        ? `orbi (tier C-composite)`
        : `orbi (tier ${cached.tier}, ${cached.providerCount} source${cached.providerCount === 1 ? "" : "s"})`,
      sourceKind: "CRYPTO_FIAT",
      pending: false,
      stale: false,
      computedOnDemand: false,
    };
  }

  // 2) Cache miss — invoke the Edge Function. supabase-js's functions.invoke
  // handles URL + headers (anon key auth, JSON body) for us.
  const client = initORBIClient();
  const { data, error } = await client.functions.invoke("on-demand-resolve", {
    body: {
      source: sourceCurrency,
      target: targetCurrency,
      effectiveAt: effectiveAt.toISOString(),
    },
  });
  if (error) {
    throw new Error(`on-demand-resolve invocation failed: ${error.message}`);
  }
  if (!data) return null;

  // The Edge Function returns the PinnedRateResult shape verbatim.
  return data as PinnedRateResult;
}
