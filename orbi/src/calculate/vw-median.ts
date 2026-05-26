/**
 * Volume-weighted median of OHLC closes across multiple sources.
 *
 * This is THE core algorithm of ORBI. The methodology document describes it
 * end-to-end at https://wiki.abascal.ca/doc/orbi-methodology-white-paper-d01sSwWofx
 * and a short reference lives in ./methodology.md at the folder root.
 *
 * VW-median is manipulation-resistant: a single bad print on one source cannot
 * drag the median unless that source represents more than 50% of trading volume
 * in the partition. Same property used by CME CF BRR, Kaiko Reference Rates,
 * Coin Metrics CMBI, and Nasdaq NQBTC.
 *
 * Anyone may fork this file, run it against the per-resolution audit log, and
 * reproduce any rate ORBI publishes. That's the public-goods commitment.
 */

import type { Candle } from "../sources/types";

export interface VwMedianResult {
  /** The canonical VW-median price. */
  price: number;
  /** Total volume across surviving sources (the denominator in cumulative-volume math). */
  totalVolume: number;
  /** Sources whose candles contributed (non-zero volume). */
  contributingSources: string[];
  /** Sources whose candles were dropped because volume = 0. */
  droppedSources: string[];
  /** Human-readable walk through the cumulative volume calculation. Stored in the audit log. */
  calculationLog: string;
}

/** Input shape: each source's candle plus the source's name for audit logging. */
export interface SourceCandle {
  source: string;
  candle: Candle;
}

/**
 * Compute the volume-weighted median across source candles.
 *
 * Algorithm:
 *   1. Drop zero-volume candles (no actual trading happened; close is the
 *      previous close repeated and would skew the median).
 *   2. Sort by close price ascending.
 *   3. Walk cumulative volume. The price at which cumulative volume crosses
 *      50% of total volume is the VW-median.
 *
 * Throws if all candles are zero-volume (no signal at all).
 */
export function vwMedian(sourceCandles: ReadonlyArray<SourceCandle>): VwMedianResult {
  if (sourceCandles.length === 0) {
    throw new Error("vwMedian: no source candles provided");
  }

  const valid: SourceCandle[] = [];
  const dropped: string[] = [];

  for (const sc of sourceCandles) {
    if (sc.candle.volume > 0) {
      valid.push(sc);
    } else {
      dropped.push(sc.source);
    }
  }

  if (valid.length === 0) {
    throw new Error(
      `vwMedian: all ${sourceCandles.length} candles had zero volume; no median is computable. Dropped: ${dropped.join(", ")}`,
    );
  }

  // Sort by close price ascending.
  valid.sort((a, b) => a.candle.close - b.candle.close);

  const totalVolume = valid.reduce((sum, sc) => sum + sc.candle.volume, 0);
  const half = totalVolume / 2;

  let cumulative = 0;
  const logLines: string[] = [
    `Total volume across ${valid.length} surviving sources: ${totalVolume.toFixed(8)}`,
    `Halfway threshold: ${half.toFixed(8)}`,
    `Walking sorted candles:`,
  ];

  let medianPrice: number | null = null;
  let medianSource: string | null = null;
  for (const sc of valid) {
    cumulative += sc.candle.volume;
    const pct = ((cumulative / totalVolume) * 100).toFixed(2);
    logLines.push(
      `  ${sc.source.padEnd(20)} close=${sc.candle.close.toFixed(2).padStart(12)}  vol=${sc.candle.volume.toFixed(8).padStart(14)}  cum=${cumulative.toFixed(8).padStart(14)}  (${pct}%)`,
    );
    if (medianPrice === null && cumulative >= half) {
      medianPrice = sc.candle.close;
      medianSource = sc.source;
    }
  }

  // Defensive: this should be unreachable since cumulative always reaches totalVolume by the last candle.
  if (medianPrice === null) {
    const last = valid[valid.length - 1]!;
    medianPrice = last.candle.close;
    medianSource = last.source;
  }

  logLines.push(`Median crossed at: ${medianSource} @ ${medianPrice.toFixed(2)}`);

  return {
    price: medianPrice,
    totalVolume,
    contributingSources: valid.map((sc) => sc.source),
    droppedSources: dropped,
    calculationLog: logLines.join("\n"),
  };
}
