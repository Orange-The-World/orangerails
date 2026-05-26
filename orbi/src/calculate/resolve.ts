/**
 * Resolve orchestrator — the core pipeline for ORBI-M.
 *
 * Given a (source_currency, target_currency, effective_at) request:
 *   1. Pick the active sources that quote the pair
 *   2. Fan out to each in parallel, fetching 1-min candles around the timestamp
 *   3. Select each source's candle for the target minute
 *   4. Run vwMedian across the surviving candles
 *   5. Return { rate, audit }
 *
 * Pure function — no DB I/O. The caller (Edge Function or script) is
 * responsible for persisting the result.
 */

import type { Source } from "../sources/interface";
import type { Candle, Pair, SourceResponse } from "../sources/types";
import { vwMedian, type SourceCandle, type VwMedianResult } from "./vw-median";

export interface ResolveRequest {
  pair: Pair;
  /** The timestamp the rate is being requested for. */
  effectiveAt: Date;
}

export interface ResolveAudit {
  /** Every source's full response, including failures. */
  providerResponses: Record<string, SourceResponse>;
  /** Sources whose candle for the target minute contributed to the median. */
  providersSucceeded: string[];
  /** Sources that failed to return a usable candle (no data, timeout, etc.). */
  providersFailed: Array<{ name: string; reason: string }>;
  /** Sources whose candle was dropped due to zero volume. */
  providersZeroVolume: string[];
  /** The cumulative-volume walk, ready for the exchange_rate_resolutions audit row. */
  calculationLog: string;
}

export interface ResolveResult {
  /** The canonical VW-median rate. */
  rate: number;
  /** Start of the 1-minute partition that this rate is for. */
  bucketTs: Date;
  /** Computed from the contributing source count. */
  tier: "A" | "B" | "B-single";
  providerCount: number;
  audit: ResolveAudit;
}

/**
 * Floor a timestamp to the start of the 1-minute bucket containing it.
 * For ORBI-M, we use the candle whose CLOSE is at the next minute boundary
 * — i.e., the candle starting at floor(effectiveAt - 1 second).
 *
 * Per methodology §3.2: "If the block was mined at 14:35:21, the candle we
 * want is the 14:34:00 → 14:35:00 candle." That candle's bucketTs is 14:34:00,
 * its close is at 14:35:00.
 */
export function partitionBucketTs(effectiveAt: Date): Date {
  // Round DOWN to the previous full minute boundary, then subtract 1 minute
  // so we get the candle that has fully closed before effectiveAt.
  const minuteFloor = Math.floor(effectiveAt.getTime() / 60_000) * 60_000;
  // If effectiveAt is exactly on a minute boundary, the bucket is the prior minute.
  // Otherwise, the candle starting at (current minute floor - 60s) covers the
  // [-60s, 0s] window relative to that minute boundary.
  return new Date(minuteFloor - 60_000);
}

/**
 * Run the resolve pipeline.
 *
 * `sources` should be the ACTIVE primary sources for the pair, determined
 * by the caller (typically by querying exchange_rate_providers for active=true
 * rows whose pairs_supported includes the requested pair).
 */
export async function resolve(
  req: ResolveRequest,
  sources: Source[],
): Promise<ResolveResult> {
  if (sources.length === 0) {
    throw new Error(`resolve: no active sources for ${req.pair.source}-${req.pair.target}`);
  }

  const bucketTs = partitionBucketTs(req.effectiveAt);
  const bucketEnd = new Date(bucketTs.getTime() + 60_000);

  // Fan out in parallel. We ask for slightly wider window to ensure we get
  // the candle covering bucketTs (some APIs are inclusive/exclusive differently).
  const windowFrom = new Date(bucketTs.getTime() - 60_000);
  const windowTo = bucketEnd;

  const responses = await Promise.all(
    sources.map((src) => src.fetch(req.pair, windowFrom, windowTo).catch((err): SourceResponse => ({
      source: src.name,
      candles: [],
      success: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      fetchedAt: new Date(),
    }))),
  );

  // Map each source's response → the candle for our target bucket
  const sourceCandles: SourceCandle[] = [];
  const providerResponses: Record<string, SourceResponse> = {};
  const providersFailed: Array<{ name: string; reason: string }> = [];
  const providersZeroVolume: string[] = [];

  for (const resp of responses) {
    providerResponses[resp.source] = resp;
    if (!resp.success) {
      providersFailed.push({
        name: resp.source,
        reason: resp.errorMessage ?? "unknown error",
      });
      continue;
    }
    const candle = pickBucketCandle(resp.candles, bucketTs);
    if (!candle) {
      providersFailed.push({
        name: resp.source,
        reason: `no candle for bucket ${bucketTs.toISOString()}`,
      });
      continue;
    }
    if (candle.volume <= 0) {
      providersZeroVolume.push(resp.source);
      continue;
    }
    sourceCandles.push({ source: resp.source, candle });
  }

  if (sourceCandles.length === 0) {
    throw new Error(
      `resolve: no contributing sources for ${req.pair.source}-${req.pair.target} at ${bucketTs.toISOString()}. ` +
        `Failed: ${providersFailed.map((p) => `${p.name}=${p.reason}`).join(", ")}. ` +
        `Zero-volume: ${providersZeroVolume.join(", ")}`,
    );
  }

  const median: VwMedianResult = vwMedian(sourceCandles);

  const tier = classifyTier(median.contributingSources.length);

  const audit: ResolveAudit = {
    providerResponses,
    providersSucceeded: median.contributingSources,
    providersFailed,
    providersZeroVolume,
    calculationLog: median.calculationLog,
  };

  return {
    rate: median.price,
    bucketTs,
    tier,
    providerCount: median.contributingSources.length,
    audit,
  };
}

/**
 * Find the candle whose bucketTs matches our target.
 * Compare on minute boundary to handle inclusive/exclusive differences.
 */
function pickBucketCandle(candles: Candle[], bucketTs: Date): Candle | null {
  const target = bucketTs.getTime();
  for (const c of candles) {
    if (c.bucketTs.getTime() === target) {
      return c;
    }
  }
  // Fallback: find the candle whose bucketTs is within the minute
  for (const c of candles) {
    const diff = Math.abs(c.bucketTs.getTime() - target);
    if (diff < 60_000) {
      return c;
    }
  }
  return null;
}

/**
 * Tier classification by number of contributing sources.
 *
 * - 3+ sources → A
 * - 2 sources → B
 * - 1 source → B-single
 */
function classifyTier(count: number): "A" | "B" | "B-single" {
  if (count >= 3) return "A";
  if (count === 2) return "B";
  return "B-single";
}
