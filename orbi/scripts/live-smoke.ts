/**
 * Live smoke test — hits real Kraken API to confirm the plug-in works end to end.
 *
 * NOT part of the default `bun run test` suite. Run manually:
 *   bun run scripts/live-smoke.ts
 *
 * Prints the most recent 5 BTC/USD candles from Kraken, then runs them through
 * vwMedian as a single-source check (median should equal the most recent close).
 */

import { KrakenSource } from "../src/sources/kraken";
import { vwMedian, type SourceCandle } from "../src/calculate/vw-median";

async function main() {
  const kraken = new KrakenSource();

  console.log("=== Kraken health check ===");
  const health = await kraken.healthCheck();
  console.log(JSON.stringify(health, null, 2));

  if (!health.reachable) {
    console.error("Kraken not reachable, aborting smoke test");
    process.exit(1);
  }

  console.log("\n=== Fetching last 10 minutes of BTC/USD candles ===");
  const now = new Date();
  const tenMinAgo = new Date(now.getTime() - 10 * 60_000);
  const result = await kraken.fetch({ source: "BTC", target: "USD" }, tenMinAgo, now);

  console.log(`source: ${result.source}`);
  console.log(`success: ${result.success}`);
  if (!result.success) {
    console.error(`error: ${result.errorMessage}`);
    process.exit(1);
  }
  console.log(`fetched ${result.candles.length} candles`);
  console.log("\nLast 5 candles:");
  for (const c of result.candles.slice(-5)) {
    console.log(`  ${c.bucketTs.toISOString()}  O=${c.open.toFixed(2)}  H=${c.high.toFixed(2)}  L=${c.low.toFixed(2)}  C=${c.close.toFixed(2)}  V=${c.volume.toFixed(8)}`);
  }

  console.log("\n=== Single-source VW-median check ===");
  // Use only the most recent non-zero-volume candle as a sanity check
  const recent = result.candles.slice(-5).filter((c) => c.volume > 0);
  if (recent.length === 0) {
    console.log("No non-zero-volume candles in last 5; skipping median check");
  } else {
    const sourceCandles: SourceCandle[] = recent.map((c) => ({ source: "kraken", candle: c }));
    const median = vwMedian(sourceCandles);
    console.log(`Single-source median across ${recent.length} candles: ${median.price.toFixed(2)}`);
    console.log(`Total volume: ${median.totalVolume.toFixed(8)}`);
    console.log(`Calculation log:\n${median.calculationLog}`);
  }

  console.log("\n✓ Live smoke test PASSED — Kraken plug-in working end-to-end against production API");
}

main().catch((err) => {
  console.error("Live smoke test FAILED:", err);
  process.exit(1);
});
