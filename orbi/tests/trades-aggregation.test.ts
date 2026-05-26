import { describe, expect, it } from "vitest";
import { aggregateTradesToCandles } from "../src/sources/trades-aggregation";

describe("aggregateTradesToCandles (shared helper)", () => {
  it("empty input returns empty", () => {
    expect(aggregateTradesToCandles([])).toEqual([]);
  });

  it("single trade → single candle, OHLC all equal", () => {
    const c = aggregateTradesToCandles([{ ts: 60_000, price: 100, amount: 1 }]);
    expect(c).toHaveLength(1);
    expect(c[0]!.open).toBe(100);
    expect(c[0]!.high).toBe(100);
    expect(c[0]!.low).toBe(100);
    expect(c[0]!.close).toBe(100);
    expect(c[0]!.volume).toBe(1);
    expect(c[0]!.bucketTs.toISOString()).toBe("1970-01-01T00:01:00.000Z");
  });

  it("multi-trade bucket: open=first, close=last, sums volume", () => {
    const c = aggregateTradesToCandles([
      { ts: 60_000, price: 100, amount: 1 },
      { ts: 70_000, price: 110, amount: 2 },
      { ts: 80_000, price:  90, amount: 0.5 },
    ]);
    expect(c).toHaveLength(1);
    expect(c[0]!.open).toBe(100);
    expect(c[0]!.close).toBe(90);
    expect(c[0]!.high).toBe(110);
    expect(c[0]!.low).toBe(90);
    expect(c[0]!.volume).toBe(3.5);
  });

  it("trades across multiple buckets produce ascending-sorted candles", () => {
    const c = aggregateTradesToCandles([
      { ts: 180_000, price: 50, amount: 1 },
      { ts:  60_000, price: 100, amount: 2 },
      { ts: 120_000, price: 75, amount: 0.5 },
    ]);
    expect(c).toHaveLength(3);
    expect(c[0]!.bucketTs.getTime()).toBe(60_000);
    expect(c[1]!.bucketTs.getTime()).toBe(120_000);
    expect(c[2]!.bucketTs.getTime()).toBe(180_000);
  });
});
