/**
 * Tier-1 additions live smoke — hits real public APIs to confirm the new
 * Coinbase Exchange plug-in works end-to-end against production.
 *
 * NOTE: The brief originally asked for a Bitfinex BTC/CAD probe as well.
 * Verification against the live Bitfinex API on 2026-05-26 showed that
 * Bitfinex does NOT list BTC/CAD — `tBTCCAD` returns
 * `["error",10020,"symbol: invalid"]`, and the public pair list
 * (/v2/conf/pub:list:pair:exchange) contains zero CAD pairs. The Bitfinex
 * extension scope item was therefore dropped; this script now only probes
 * Coinbase Exchange plus a Bitfinex BTC/USD regression check.
 *
 * Read-only — does NOT write any rows. Founder runs this on bb-support to
 * verify before flipping providers active in PROD.
 *
 * Usage:
 *   cd ~/AIHUB/REPOS/orangerails/orbi
 *   bun run scripts/smoke-tier1-additions.ts
 */

import { CoinbaseExchangeSource } from "../src/sources/coinbase-exchange";
import { BitfinexSource } from "../src/sources/bitfinex";
import type { Pair, SourceResponse } from "../src/sources/types";
import type { Source } from "../src/sources/interface";

function printResponse(label: string, res: SourceResponse): void {
  console.log(`\n--- ${label} ---`);
  console.log(`  source:  ${res.source}`);
  console.log(`  success: ${res.success}`);
  if (!res.success) {
    console.log(`  error:   ${res.errorMessage}`);
    return;
  }
  console.log(`  candles: ${res.candles.length}`);
  // Print the most recent candle (last in time order; Coinbase returns
  // most-recent-first, Bitfinex returns ascending when sort=1).
  const sorted = [...res.candles].sort((a, b) => a.bucketTs.getTime() - b.bucketTs.getTime());
  const last = sorted[sorted.length - 1];
  if (last) {
    console.log(
      `  latest:  ${last.bucketTs.toISOString()}  ` +
        `O=${last.open}  H=${last.high}  L=${last.low}  C=${last.close}  V=${last.volume}`,
    );
  } else {
    console.log("  latest:  (no candles in window)");
  }
}

async function smokeOne(src: Source, pair: Pair, label: string): Promise<boolean> {
  const now = new Date();
  // Use a 60-min window so illiquid pairs (BTC-INR, BTC-CAD) still capture
  // at least one minute candle with trades.
  const from = new Date(now.getTime() - 60 * 60_000);
  const res = await src.fetch(pair, from, now);
  printResponse(label, res);
  return res.success && res.candles.length > 0;
}

async function main() {
  console.log("=== ORBI Tier-1 additions smoke test ===");
  console.log("Read-only. No writes. Public APIs only.");

  const coinbase = new CoinbaseExchangeSource();
  const bitfinex = new BitfinexSource();

  let allReachable = true;
  let illiquidEmpty = 0;

  // Coinbase Exchange — four pairs. BTC-INR is listed but very illiquid; an
  // empty window is informational, not a failure of the plug-in.
  for (const target of ["USD", "EUR", "GBP", "INR"]) {
    const res = await coinbase.fetch(
      { source: "BTC", target },
      new Date(Date.now() - 60 * 60_000),
      new Date(),
    );
    printResponse(`Coinbase Exchange BTC/${target}`, res);
    if (!res.success) allReachable = false;
    if (res.success && res.candles.length === 0) illiquidEmpty++;
  }

  // Sanity: Bitfinex BTC/USD still works (no scope change there)
  const okUsd = await smokeOne(
    bitfinex,
    { source: "BTC", target: "USD" },
    "Bitfinex BTC/USD (regression check — unchanged)",
  );
  if (!okUsd) allReachable = false;

  console.log("\n=== Summary ===");
  if (allReachable) {
    console.log(
      `All probes reached the API successfully. ` +
        `${illiquidEmpty} pair(s) returned zero candles in the 60-min window ` +
        `(expected for illiquid listings like BTC-INR — the product exists, ` +
        `it just had no trades). Safe to promote Coinbase Exchange.`,
    );
    process.exit(0);
  } else {
    console.log("One or more probes failed to reach the API. Investigate before promoting.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Smoke test FAILED with uncaught error:", err);
  process.exit(1);
});
