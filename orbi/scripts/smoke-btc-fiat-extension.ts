/**
 * Smoke test for the 2026-05-27 BTC/fiat extension batch.
 *
 * Hits each new source for a recent 5-minute window and prints the
 * resolved candles. No DB writes. Run keylessly.
 *
 * Usage: bun run scripts/smoke-btc-fiat-extension.ts
 */

import { BtseSource } from "../src/sources/btse";
import { FiriSource } from "../src/sources/firi";
import { IndependentReserveSource } from "../src/sources/independent-reserve";
import { FrankfurterSource } from "../src/sources/frankfurter";

async function probe(name: string, source: any, target: string) {
  const to = new Date();
  const from = new Date(to.getTime() - 10 * 60_000);
  const resp = await source.fetch({ source: "BTC", target }, from, to);
  if (!resp.success) {
    console.log(`  ${name} BTC/${target}: FAIL — ${resp.errorMessage}`);
    return;
  }
  const last = resp.candles[resp.candles.length - 1];
  if (!last) {
    console.log(`  ${name} BTC/${target}: OK but 0 candles in 10-min window`);
    return;
  }
  console.log(
    `  ${name} BTC/${target}: ${resp.candles.length} candle(s), latest close=${last.close} vol=${last.volume}`,
  );
}

async function probeFrankfurter(target: string) {
  const f = new FrankfurterSource();
  const to = new Date();
  const from = new Date(to.getTime() - 24 * 60 * 60_000);
  const resp = await f.fetch({ source: "USD", target }, from, to);
  if (!resp.success) {
    console.log(`  frankfurter USD/${target}: FAIL — ${resp.errorMessage}`);
    return;
  }
  const last = resp.candles[resp.candles.length - 1];
  console.log(`  frankfurter USD/${target}: ${resp.candles.length} candle(s), latest close=${last?.close}`);
}

async function main() {
  console.log("=== BTSE ===");
  await probe("btse", new BtseSource(), "HKD");

  console.log("=== Firi ===");
  const firi = new FiriSource();
  await probe("firi", firi, "NOK");
  await probe("firi", firi, "DKK");

  console.log("=== Independent Reserve ===");
  const ir = new IndependentReserveSource();
  await probe("independent_reserve", ir, "SGD");
  await probe("independent_reserve", ir, "NZD");
  await probe("independent_reserve", ir, "AUD");

  console.log("=== Frankfurter (composite cross-rate prerequisites) ===");
  for (const t of ["HKD", "SGD", "NOK", "SEK", "DKK", "NZD"]) {
    await probeFrankfurter(t);
  }
}

main().catch((e) => {
  console.error("smoke FAILED:", e);
  process.exit(1);
});
