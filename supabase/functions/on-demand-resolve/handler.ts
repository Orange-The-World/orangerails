/**
 * HTTP handler for on-demand-resolve. Split from index.ts so unit tests can
 * import it without booting Deno.serve or building the source registry.
 *
 * Pure-ish: receives a Request and a deps bundle (Supabase client factory,
 * source plug-ins, resolve functions, rate-limit gate). Returns a Response.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { partitionBucketTs, type ResolveResult } from "../../../orbi/src/calculate/resolve.ts";
import type { CompositeResolveResult } from "../../../orbi/src/calculate/resolve-composite.ts";
import type { Source } from "../../../orbi/src/sources/interface.ts";

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const JSON_HEADERS = { ...CORS_HEADERS, "Content-Type": "application/json" };

/**
 * The shape returned to the client. Matches V3's PinnedRateResult with one
 * extra field (computedOnDemand). The client layer in orbi/src/client/rates.ts
 * is the canonical consumer.
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

export interface HandlerDeps {
  getClient: () => SupabaseClient;
  resolveDirect: (
    req: { pair: { source: string; target: string }; effectiveAt: Date },
    sources: Source[],
  ) => Promise<ResolveResult>;
  resolveComposite: (req: {
    pair: { source: string; target: string };
    effectiveAt: Date;
    btcSources: Source[];
    crossRateSource: Source;
  }) => Promise<CompositeResolveResult>;
  allBtcSources: Source[];
  frankfurter: Source;
  compositeTargets: Set<string>;
  checkRateLimit: (ip: string) => boolean;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function getClientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-real-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

function sourcesForTarget(all: Source[], target: string): Source[] {
  return all.filter((s) => s.pairsSupported.includes(`BTC-${target}`));
}

/**
 * Read query params from either a GET querystring or a POST JSON body.
 */
async function readParams(
  req: Request,
): Promise<{ source: string | null; target: string | null; effectiveAt: string | null }> {
  const url = new URL(req.url);
  let source = url.searchParams.get("source");
  let target = url.searchParams.get("target");
  let effectiveAt = url.searchParams.get("effectiveAt");
  if (req.method === "POST" && (!source || !target || !effectiveAt)) {
    try {
      const body = (await req.json()) as Record<string, unknown>;
      source = source ?? (typeof body.source === "string" ? body.source : null);
      target = target ?? (typeof body.target === "string" ? body.target : null);
      effectiveAt =
        effectiveAt ?? (typeof body.effectiveAt === "string" ? body.effectiveAt : null);
    } catch {
      // Ignore — empty / non-JSON body falls through to validation
    }
  }
  return { source, target, effectiveAt };
}

function rowToResult(
  row: {
    id: string;
    rate: number | string;
    bucket_ts: string;
    tier: string;
    provider_count: number;
    composite: boolean;
  },
  computedOnDemand: boolean,
  staleVsRequest: boolean,
): PinnedRateResult {
  const tierLabel = row.composite
    ? `orbi (tier C-composite)`
    : `orbi (tier ${row.tier}, ${row.provider_count} source${row.provider_count === 1 ? "" : "s"})`;
  return {
    rate: typeof row.rate === "string" ? Number(row.rate) : row.rate,
    rateId: row.id,
    bucketTs: row.bucket_ts,
    bucketGranularity: "M",
    provider: tierLabel,
    sourceKind: "CRYPTO_FIAT",
    pending: false,
    stale: staleVsRequest,
    computedOnDemand,
  };
}

export async function handleRequest(req: Request, deps: HandlerDeps): Promise<Response> {
  // Rate-limit gate
  const ip = getClientIp(req);
  if (!deps.checkRateLimit(ip)) {
    return json({ error: "rate limit exceeded (30 req/min/ip)" }, 429);
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // Param parsing + validation
  const { source, target, effectiveAt } = await readParams(req);
  if (!source || !target || !effectiveAt) {
    return json({ error: "source, target, effectiveAt all required" }, 400);
  }
  if (source !== "BTC") {
    return json({ error: `source must be BTC (got ${source})` }, 400);
  }
  if (!/^[A-Z]{3}$/.test(target)) {
    return json({ error: `target must be a 3-letter ISO code (got ${target})` }, 400);
  }
  const effectiveDate = new Date(effectiveAt);
  if (Number.isNaN(effectiveDate.getTime())) {
    return json({ error: `effectiveAt must be parseable ISO timestamp (got ${effectiveAt})` }, 400);
  }
  // Refuse future minutes that haven't closed yet — the candles wouldn't exist.
  if (effectiveDate.getTime() > Date.now() - 60_000) {
    return json({ error: "effectiveAt must be at least 1 minute in the past" }, 400);
  }

  const bucketTs = partitionBucketTs(effectiveDate);
  const bucketTsIso = bucketTs.toISOString();
  const client = deps.getClient();

  // Step 1: cache lookup — service-role bypasses RLS so we see all statuses
  // but we only return CONFIRMED rows to callers.
  const cached = await client
    .from("exchange_rates")
    .select("id, rate, bucket_ts, tier, provider_count, composite")
    .eq("source_currency", "BTC")
    .eq("target_currency", target)
    .eq("product", "ORBI-M")
    .eq("granularity", "1m")
    .eq("status", "CONFIRMED")
    .eq("bucket_ts", bucketTsIso)
    .maybeSingle();

  if (cached.error) {
    return json({ error: `cache lookup failed: ${cached.error.message}` }, 500);
  }
  if (cached.data) {
    return json(rowToResult(cached.data, false, false));
  }

  // Step 2: cache miss — resolve from upstream sources
  const isComposite = deps.compositeTargets.has(target);
  try {
    if (isComposite) {
      const result = await deps.resolveComposite({
        pair: { source: "BTC", target },
        effectiveAt: effectiveDate,
        btcSources: deps.allBtcSources.slice(0, 6), // exclude Mercado Bitcoin (no USD pair)
        crossRateSource: deps.frankfurter,
      });
      const rateId = await writeComposite(client, target, result);
      return json({
        rate: result.rate,
        rateId,
        bucketTs: result.bucketTs.toISOString(),
        bucketGranularity: "M",
        provider: `orbi (tier C-composite via ${result.audit.crossRateSource})`,
        sourceKind: "CRYPTO_FIAT",
        pending: false,
        stale: false,
        computedOnDemand: true,
      } satisfies PinnedRateResult);
    }

    const sources = sourcesForTarget(deps.allBtcSources, target);
    if (sources.length === 0) {
      return json(
        { error: `no direct sources for BTC-${target}; pair not yet supported` },
        404,
      );
    }
    const result = await deps.resolveDirect(
      { pair: { source: "BTC", target }, effectiveAt: effectiveDate },
      sources,
    );
    const rateId = await writeDirect(client, target, result);
    return json({
      rate: result.rate,
      rateId,
      bucketTs: result.bucketTs.toISOString(),
      bucketGranularity: "M",
      provider: `orbi (tier ${result.tier}, ${result.providerCount} source${result.providerCount === 1 ? "" : "s"})`,
      sourceKind: "CRYPTO_FIAT",
      pending: false,
      stale: false,
      computedOnDemand: true,
    } satisfies PinnedRateResult);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: `resolve failed: ${msg}` }, 502);
  }
}

/**
 * Write a fresh direct-pair rate + audit row. Idempotent via ON CONFLICT —
 * if a concurrent request raced us, we update in place and return the existing id.
 */
async function writeDirect(
  client: SupabaseClient,
  target: string,
  result: ResolveResult,
): Promise<string> {
  const upsert = await client
    .from("exchange_rates")
    .upsert(
      {
        source_currency: "BTC",
        target_currency: target,
        bucket_ts: result.bucketTs.toISOString(),
        granularity: "1m",
        product: "ORBI-M",
        rate: result.rate,
        tier: result.tier,
        composite: false,
        composite_via: null,
        provider_count: result.providerCount,
        status: "CONFIRMED",
        provenance: "on-demand-resolve",
        fetched_at: new Date().toISOString(),
        computed_at: new Date().toISOString(),
      },
      {
        onConflict: "source_currency,target_currency,bucket_ts,granularity,product,source_authority",
      },
    )
    .select("id")
    .single();

  if (upsert.error || !upsert.data) {
    throw new Error(`write exchange_rates failed: ${upsert.error?.message ?? "no row returned"}`);
  }
  const rateId = upsert.data.id as string;

  const audit = await client.from("exchange_rate_resolutions").insert({
    rate_id: rateId,
    provider_responses: result.audit.providerResponses,
    providers_succeeded: result.audit.providersSucceeded,
    providers_failed: result.audit.providersFailed,
    outliers_discarded: result.audit.providersZeroVolume,
    median_calculation: result.audit.calculationLog,
    fetched_at: new Date().toISOString(),
  });
  if (audit.error) {
    // Audit failure is non-fatal for the caller (rate is already CONFIRMED in
    // exchange_rates). Log and continue. In Edge runtime this surfaces via the
    // Supabase function logs UI.
    console.error(`audit write failed for rate ${rateId}: ${audit.error.message}`);
  }
  return rateId;
}

async function writeComposite(
  client: SupabaseClient,
  target: string,
  result: CompositeResolveResult,
): Promise<string> {
  const upsert = await client
    .from("exchange_rates")
    .upsert(
      {
        source_currency: "BTC",
        target_currency: target,
        bucket_ts: result.bucketTs.toISOString(),
        granularity: "1m",
        product: "ORBI-M",
        rate: result.rate,
        tier: "C-composite",
        composite: true,
        composite_via: result.compositeVia,
        provider_count: result.btcUsd.providerCount,
        status: "CONFIRMED",
        provenance: "on-demand-resolve",
        fetched_at: new Date().toISOString(),
        computed_at: new Date().toISOString(),
      },
      {
        onConflict: "source_currency,target_currency,bucket_ts,granularity,product,source_authority",
      },
    )
    .select("id")
    .single();

  if (upsert.error || !upsert.data) {
    throw new Error(`write exchange_rates failed: ${upsert.error?.message ?? "no row returned"}`);
  }
  const rateId = upsert.data.id as string;

  const responseBundle = {
    btcUsd: result.btcUsd.audit.providerResponses,
    crossRate: { name: result.audit.crossRateSource, rate: result.crossRate },
  };
  const succeeded = result.btcUsd.audit.providersSucceeded.concat([
    result.audit.crossRateSource,
  ]);
  const audit = await client.from("exchange_rate_resolutions").insert({
    rate_id: rateId,
    provider_responses: responseBundle,
    providers_succeeded: succeeded,
    providers_failed: result.btcUsd.audit.providersFailed,
    outliers_discarded: [],
    median_calculation: `${result.audit.formula}\n\n${result.btcUsd.audit.calculationLog}`,
    fetched_at: new Date().toISOString(),
  });
  if (audit.error) {
    console.error(`composite audit write failed for rate ${rateId}: ${audit.error.message}`);
  }
  return rateId;
}
