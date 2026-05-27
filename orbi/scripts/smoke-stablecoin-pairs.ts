/**
 * Live smoke test for stablecoin / fiat-peg spot pairs.
 *
 * Hits the real public APIs of Kraken, Bitfinex, and Coinbase Exchange and
 * prints the latest 1-minute candle for each (pair, source) combination
 * declared in the source plug-ins. Read-only — does NOT write any rows.
 *
 * Usage:
 *   cd ~/AIHUB/REPOS/orangerails/orbi
 *   bun run scripts/smoke-stablecoin-pairs.ts
 */

import { KrakenSource } from "../src/sources/kraken";
import { BitfinexSource } from "../src/sources/bitfinex";
import { CoinbaseExchangeSource } from "../src/sources/coinbase-exchange";
import type { Source } from "../src/sources/interface";
import type { Pair, SourceResponse } from "../src/sources/types";

const STABLECOIN_PAIRS: Pair[] = [
  { source: "USDT", target: "USD" },
  { source: "USDC", target: "USD" },
  { source: "DAI", target: "USD" },
  { source: "PYUSD", target: "USD" },
  { source: "EURC", target: "EUR" },
];

const SOURCES: Source[] = [
  new KrakenSource(),
  new BitfinexSource(),
  new CoinbaseExchangeSource(),
];

function printResp(label: string, res: SourceResponse): void {
  const head = `[${label}] ${res.source}`;
  if (!res.success) {
    console.log(`${head}: FAIL — ${res.errorMessage}`);
    return;
  }
  const sorted = [...res.candles].sort((a, b) => a.bucketTs.getTime() - b.bucketTs.getTime());
  const last = sorted[sorted.length - 1];
  if (!last) {
    console.log(`${head}: success but 0 candles`);
    return;
  }
  console.log(
    `${head}: ${res.candles.length} candles, latest ${last.bucketTs.toISOString()} close=${last.close} vol=${last.volume}`,
  );
}

async function main() {
  console.log("=== Stablecoin / fiat-peg live smoke (read-only) ===");
  const now = new Date();
  // 60-min window — plenty of room for low-volume pegs
  const from = new Date(now.getTime() - 60 * 60_000);

  for (const pair of STABLECOIN_PAIRS) {
    const code = `${pair.source}-${pair.target}`;
    console.log(`\n-- ${code} --`);
    for (const src of SOURCES) {
      if (!src.pairsSupported.includes(code)) {
        console.log(`[skip] ${src.name}: not configured for ${code}`);
        continue;
      }
      try {
        const res = await src.fetch(pair, from, now);
        printResp(code, res);
      } catch (err) {
        console.log(`[err] ${src.name} ${code}: ${(err as Error).message}`);
      }
    }
  }
  console.log("\n=== smoke done ===");
}

main().catch((err) => {
  console.error("smoke FAILED:", err);
  process.exit(1);
});
