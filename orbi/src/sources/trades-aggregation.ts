/**
 * Shared trade-tick → 1-minute OHLC aggregation helper.
 *
 * Several public exchanges (Coincheck, Independent Reserve, VALR, Paribu,
 * Ripio, Coincheck) do NOT publish minute-candle endpoints on their
 * keyless public API, but DO publish recent-trades. This helper produces
 * OHLC bars from a list of trade ticks, identical in semantics to the
 * private aggregator inside `bitso.ts`. Factored out so multiple plug-ins
 * can share the same code path without modifying the existing Bitso plug-in.
 *
 * Input: a chronologically-sorted (or unsorted) array of trades with
 *        millisecond timestamps, price in target fiat, and amount in BTC.
 *
 * Output: zero-or-more Candles, one per 1-minute bucket present in the data,
 *         sorted ascending by bucket timestamp. Volume is summed; high/low
 *         are price extremes; open/close are first/last trade in the bucket.
 *
 * Zero-volume buckets cannot appear in the output (a bucket exists only
 * because at least one trade landed in it).
 */

import type { Candle } from "./types.ts";

export function aggregateTradesToCandles(
  trades: ReadonlyArray<{ ts: number; price: number; amount: number }>,
): Candle[] {
  if (trades.length === 0) return [];

  const byBucket = new Map<number, Array<{ ts: number; price: number; amount: number }>>();
  for (const t of trades) {
    const bucketMs = Math.floor(t.ts / 60_000) * 60_000;
    let bucket = byBucket.get(bucketMs);
    if (!bucket) {
      bucket = [];
      byBucket.set(bucketMs, bucket);
    }
    bucket.push(t);
  }

  const candles: Candle[] = [];
  for (const [bucketMs, bucketTrades] of byBucket) {
    bucketTrades.sort((a, b) => a.ts - b.ts);
    const open = bucketTrades[0]!.price;
    const close = bucketTrades[bucketTrades.length - 1]!.price;
    let high = bucketTrades[0]!.price;
    let low = bucketTrades[0]!.price;
    let volume = 0;
    for (const t of bucketTrades) {
      if (t.price > high) high = t.price;
      if (t.price < low) low = t.price;
      volume += t.amount;
    }
    candles.push({
      bucketTs: new Date(bucketMs),
      open,
      high,
      low,
      close,
      volume,
    });
  }

  candles.sort((a, b) => a.bucketTs.getTime() - b.bucketTs.getTime());
  return candles;
}
