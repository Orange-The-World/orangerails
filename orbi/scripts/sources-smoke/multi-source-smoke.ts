/**
 * Multi-source live smoke test.
 *
 * Hits the real public endpoints for every new source plug-in shipped in
 * migration 009 and prints one line per source with (success / candle count /
 * close-of-last candle / errorMessage). Run manually before flipping any
 * source `active=TRUE`. Never wired into CI (real network).
 *
 *   bun run scripts/sources-smoke/multi-source-smoke.ts
 *
 * No assertions; failures are reported as `FAIL`. This is a manual sanity
 * tool only.
 */

import { CoincheckSource } from "../../src/sources/coincheck";
import { BitbankSource } from "../../src/sources/bitbank";
import { IndependentReserveSource } from "../../src/sources/independent-reserve";
import { BtcMarketsSource } from "../../src/sources/btc-markets";
import { BtcTurkSource } from "../../src/sources/btcturk";
import { ParibuSource } from "../../src/sources/paribu";
import { LunoSource } from "../../src/sources/luno";
import { ValrSource } from "../../src/sources/valr";
import { UpbitSource } from "../../src/sources/upbit";
import { BithumbSource } from "../../src/sources/bithumb";
import { RipioSource } from "../../src/sources/ripio";
import type { Source } from "../../src/sources/interface";
import type { Pair } from "../../src/sources/types";

interface Probe { src: Source; pair: Pair; }

const probes: Probe[] = [
  { src: new CoincheckSource(),          pair: { source: "BTC", target: "JPY" } },
  { src: new BitbankSource(),            pair: { source: "BTC", target: "JPY" } },
  { src: new IndependentReserveSource(), pair: { source: "BTC", target: "AUD" } },
  { src: new BtcMarketsSource(),         pair: { source: "BTC", target: "AUD" } },
  { src: new BtcTurkSource(),            pair: { source: "BTC", target: "TRY" } },
  { src: new ParibuSource(),             pair: { source: "BTC", target: "TRY" } },
  { src: new LunoSource(),               pair: { source: "BTC", target: "ZAR" } },
  { src: new ValrSource(),               pair: { source: "BTC", target: "ZAR" } },
  { src: new UpbitSource(),              pair: { source: "BTC", target: "KRW" } },
  { src: new BithumbSource(),            pair: { source: "BTC", target: "KRW" } },
  { src: new RipioSource(),              pair: { source: "BTC", target: "ARS" } },
];

async function main() {
  const now = Date.now();
  const from = new Date(now - 10 * 60 * 1000); // last 10 minutes
  const to = new Date(now);

  console.log(`ORBI multi-source smoke — window ${from.toISOString()} → ${to.toISOString()}`);
  console.log("---");

  for (const p of probes) {
    const r = await p.src.fetch(p.pair, from, to);
    if (r.success) {
      const last = r.candles[r.candles.length - 1];
      const lastClose = last ? last.close.toString() : "n/a";
      const lastTs = last ? last.bucketTs.toISOString() : "n/a";
      console.log(
        `OK   ${p.src.name.padEnd(20)} ${p.pair.source}/${p.pair.target}  ` +
        `candles=${r.candles.length.toString().padStart(3)}  ` +
        `lastClose=${lastClose}  lastTs=${lastTs}`,
      );
    } else {
      console.log(
        `FAIL ${p.src.name.padEnd(20)} ${p.pair.source}/${p.pair.target}  ` +
        `err=${r.errorMessage}`,
      );
    }
  }
}

main().catch((err) => {
  console.error("smoke runner threw:", err);
  process.exit(1);
});
