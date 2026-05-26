/**
 * Composite Tier C resolution: BTC↔X via USD cross-rate.
 *
 * For currencies where no direct BTC source quotes BTC↔X natively
 * (e.g., BTC↔INR, BTC↔TRY, BTC↔ZAR), compute:
 *
 *     BTC/X = BTC/USD ORBI × USD/X Frankfurter
 *
 * The result is tier 'C-composite' with audit-log noting both halves.
 * Per methodology §7.5 the composite formula is auditable and transparent;
 * customers can recompute it by combining the two underlying audit rows.
 *
 * Frankfurter provides USD↔X daily ECB rates back to 1999-01-04.
 */

import type { Source } from "../sources/interface";
import type { Pair } from "../sources/types";
import { resolve, type ResolveResult } from "./resolve";

export interface CompositeResolveRequest {
  /** The target pair, e.g. {source: 'BTC', target: 'INR'}. */
  pair: Pair;
  effectiveAt: Date;
  /** Active BTC sources (used to resolve the BTC↔USD half). */
  btcSources: Source[];
  /** The Frankfurter (or equivalent) cross-rate source. */
  crossRateSource: Source;
}

export interface CompositeResolveResult {
  rate: number;
  bucketTs: Date;
  tier: "C-composite";
  composite: true;
  compositeVia: string;
  /** The BTC↔USD ORBI result that feeds the composite. */
  btcUsd: ResolveResult;
  /** The fiat cross-rate (USD↔target). */
  crossRate: number;
  /** Audit log entry combining both halves. */
  audit: {
    btcUsdResolution: ResolveResult["audit"];
    crossRateSource: string;
    crossRateValue: number;
    formula: string;
  };
}

export async function resolveComposite(req: CompositeResolveRequest): Promise<CompositeResolveResult> {
  if (req.pair.source !== "BTC") {
    throw new Error(`resolveComposite: only BTC source supported, got ${req.pair.source}`);
  }
  if (req.pair.target === "USD") {
    throw new Error(`resolveComposite: BTC/USD is direct, not composite. Use resolve() instead.`);
  }

  // Step 1: resolve BTC/USD via the standard VW-median pipeline
  const btcUsd = await resolve(
    { pair: { source: "BTC", target: "USD" }, effectiveAt: req.effectiveAt },
    req.btcSources,
  );

  // Step 2: fetch USD/target from Frankfurter
  const crossResp = await req.crossRateSource.fetch(
    { source: "USD", target: req.pair.target },
    new Date(req.effectiveAt.getTime() - 7 * 24 * 60 * 60_000), // allow up to a week back for weekends/holidays
    req.effectiveAt,
  );
  if (!crossResp.success || crossResp.candles.length === 0) {
    throw new Error(
      `resolveComposite: cross-rate source ${req.crossRateSource.name} returned no data for USD-${req.pair.target}: ${crossResp.errorMessage ?? "no candles"}`,
    );
  }

  // Use the most recent candle (Frankfurter daily; latest business day)
  const crossCandle = crossResp.candles.reduce((a, b) =>
    a.bucketTs.getTime() > b.bucketTs.getTime() ? a : b,
  );
  const crossRate = crossCandle.close;

  // Step 3: multiply
  const composite = btcUsd.rate * crossRate;
  const formula = `BTC/${req.pair.target} = BTC/USD (${btcUsd.rate.toFixed(2)}) × USD/${req.pair.target} (${crossRate.toFixed(6)}) = ${composite.toFixed(2)}`;

  return {
    rate: composite,
    bucketTs: btcUsd.bucketTs,
    tier: "C-composite",
    composite: true,
    compositeVia: `BTC-USD * USD-${req.pair.target}`,
    btcUsd,
    crossRate,
    audit: {
      btcUsdResolution: btcUsd.audit,
      crossRateSource: req.crossRateSource.name,
      crossRateValue: crossRate,
      formula,
    },
  };
}
