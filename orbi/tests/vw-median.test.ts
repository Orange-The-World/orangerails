/**
 * Worked-example tests for the VW-median algorithm.
 *
 * Every test case below is a SPECIFIC scenario from the methodology document.
 * Anyone reading the methodology must be able to run these tests and reproduce
 * the numbers shown there. If a test fails after a code change, the methodology
 * document is wrong OR the code is wrong — both require an explicit decision.
 */

import { describe, expect, it } from "vitest";
import { vwMedian, type SourceCandle } from "../src/calculate/vw-median";
import type { Candle } from "../src/sources/types";

function candle(close: number, volume: number, open = close, high = close, low = close): Candle {
  return { bucketTs: new Date("2026-03-14T14:34:00Z"), open, high, low, close, volume };
}

describe("vwMedian — methodology document examples", () => {
  it("normal trading minute across 3 sources (Kraken/Bitstamp/Bitfinex) — methodology §4", () => {
    // The methodology's worked example uses these specific numbers.
    const sources: SourceCandle[] = [
      { source: "bitfinex", candle: candle(67180, 6) },
      { source: "kraken", candle: candle(67200, 18) },
      { source: "bitstamp", candle: candle(67220, 5) },
    ];

    const result = vwMedian(sources);

    // Total volume = 29 BTC. Half = 14.5.
    // Sorted: Bitfinex 67180 (6, cum=6), Kraken 67200 (18, cum=24 ← crosses 50%), Bitstamp 67220.
    // Median = Kraken's close = 67200.
    expect(result.price).toBe(67200);
    expect(result.totalVolume).toBe(29);
    expect(result.contributingSources).toEqual(["bitfinex", "kraken", "bitstamp"]);
    expect(result.droppedSources).toEqual([]);
  });

  it("flash crash on Bitfinex does NOT drag the median — methodology §4", () => {
    // Same minute but Bitfinex prints $60,000 due to a fat-finger sell.
    const sources: SourceCandle[] = [
      { source: "bitfinex", candle: candle(60000, 6) }, // bad print
      { source: "kraken", candle: candle(67200, 18) },
      { source: "bitstamp", candle: candle(67220, 5) },
    ];

    const result = vwMedian(sources);

    // Bitfinex moves to the bottom of the sort but only contributes 6 BTC volume.
    // Cumulative still crosses 50% at Kraken's price. Median unchanged.
    expect(result.price).toBe(67200);

    // For comparison, the volume-weighted MEAN would drop substantially:
    // (60000*6 + 67200*18 + 67220*5) / 29 = $65,714 — 2.2% lower than reality.
    // The whole point of VW-median is this resistance.
  });

  it("zero-volume candle is dropped from the median", () => {
    const sources: SourceCandle[] = [
      { source: "kraken", candle: candle(67200, 18) },
      { source: "bitstamp", candle: candle(67220, 5) },
      { source: "mempool", candle: candle(67230, 0) }, // mempool reports no trades
    ];

    const result = vwMedian(sources);

    expect(result.contributingSources).toEqual(["kraken", "bitstamp"]);
    expect(result.droppedSources).toEqual(["mempool"]);
    // Median across Kraken (18) + Bitstamp (5), half=11.5. Kraken at cum=18 wins.
    expect(result.price).toBe(67200);
  });

  it("throws if all candles are zero-volume", () => {
    const sources: SourceCandle[] = [
      { source: "kraken", candle: candle(67200, 0) },
      { source: "bitstamp", candle: candle(67220, 0) },
    ];

    expect(() => vwMedian(sources)).toThrow(/all .* candles had zero volume/);
  });

  it("throws if no source candles are provided at all", () => {
    expect(() => vwMedian([])).toThrow(/no source candles provided/);
  });

  it("4-source panel including a flash crash and a stale-tick zero-volume", () => {
    // Realistic ORBI-M scenario: 4 sources, one outlier, one stale.
    const sources: SourceCandle[] = [
      { source: "kraken", candle: candle(67200, 18) },
      { source: "bitstamp", candle: candle(67220, 5) },
      { source: "bitfinex", candle: candle(60000, 6) }, // flash crash
      { source: "mempool", candle: candle(67500, 0) }, // stale, no trades
    ];

    const result = vwMedian(sources);

    expect(result.droppedSources).toEqual(["mempool"]);
    expect(result.contributingSources).toEqual(["bitfinex", "kraken", "bitstamp"]);
    // Same as the flash-crash test: median unchanged at 67200.
    expect(result.price).toBe(67200);
  });

  it("includes a human-readable calculation log for the audit row", () => {
    const sources: SourceCandle[] = [
      { source: "kraken", candle: candle(67200, 18) },
      { source: "bitstamp", candle: candle(67220, 5) },
    ];
    const result = vwMedian(sources);
    expect(result.calculationLog).toContain("Total volume across 2 surviving sources");
    expect(result.calculationLog).toContain("kraken");
    expect(result.calculationLog).toContain("Median crossed at: kraken @ 67200.00");
  });
});
