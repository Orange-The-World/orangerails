import { describe, expect, it, vi, beforeEach } from "vitest";
import { BitsoSource, aggregateTradesToCandles } from "../src/sources/bitso";

const SAMPLE_TRADES = {
  success: true,
  payload: [
    // Most recent first (Bitso default sort=desc)
    { book: "btc_mxn", created_at: "2026-05-26T03:35:55Z", amount: "0.05", maker_side: "sell", price: "1234650", tid: 3 },
    { book: "btc_mxn", created_at: "2026-05-26T03:35:30Z", amount: "0.12", maker_side: "buy", price: "1234500", tid: 2 },
    { book: "btc_mxn", created_at: "2026-05-26T03:35:10Z", amount: "0.08", maker_side: "buy", price: "1234600", tid: 1 },
    { book: "btc_mxn", created_at: "2026-05-26T03:34:50Z", amount: "0.03", maker_side: "sell", price: "1234100", tid: 0 },
  ],
};

function mockFetchResponse(jsonBody: unknown, status = 200): Response {
  return new Response(JSON.stringify(jsonBody), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("BitsoSource — unit tests", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("config: bitso, primary, 1 rps, includes LatAm pairs", () => {
    const src = new BitsoSource();
    expect(src.name).toBe("bitso");
    expect(src.role).toBe("primary");
    expect(src.rateLimitRps).toBe(1.0);
    expect(src.pairsSupported).toContain("BTC-MXN");
    expect(src.pairsSupported).toContain("BTC-BRL");
    expect(src.pairsSupported).toContain("BTC-ARS");
  });

  it("fetch: aggregates trades into 1-minute candles", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(SAMPLE_TRADES)));
    const src = new BitsoSource();
    const result = await src.fetch(
      { source: "BTC", target: "MXN" },
      new Date("2026-05-26T03:34:00Z"),
      new Date("2026-05-26T03:36:00Z"),
    );
    expect(result.success).toBe(true);
    // 2 buckets: 03:34 (1 trade) and 03:35 (3 trades)
    expect(result.candles).toHaveLength(2);

    const c34 = result.candles[0]!;
    const c35 = result.candles[1]!;
    expect(c34.bucketTs.toISOString()).toBe("2026-05-26T03:34:00.000Z");
    expect(c34.volume).toBeCloseTo(0.03);

    expect(c35.bucketTs.toISOString()).toBe("2026-05-26T03:35:00.000Z");
    expect(c35.volume).toBeCloseTo(0.25); // 0.08+0.12+0.05
    // 3 trades in ascending time: 03:35:10 (1234600), 03:35:30 (1234500), 03:35:55 (1234650)
    expect(c35.open).toBe(1234600);
    expect(c35.close).toBe(1234650);
    expect(c35.high).toBe(1234650);
    expect(c35.low).toBe(1234500);
  });

  it("fetch: unsupported pair → success=false", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const src = new BitsoSource();
    const result = await src.fetch({ source: "BTC", target: "EUR" }, new Date(), new Date());
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("unsupported pair");
  });

  it("fetch: API error (success=false) → success=false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockFetchResponse({ success: false, error: { code: "0102", message: "rate limit" } })),
    );
    const src = new BitsoSource();
    const result = await src.fetch(
      { source: "BTC", target: "MXN" },
      new Date("2026-05-26T03:34:00Z"),
      new Date("2026-05-26T03:36:00Z"),
    );
    expect(result.success).toBe(false);
  });

  it("aggregateTradesToCandles: groups multiple trades correctly", () => {
    const trades = [
      { ts: new Date("2026-05-26T03:35:10Z").getTime(), price: 100, amount: 1 },
      { ts: new Date("2026-05-26T03:35:30Z").getTime(), price: 105, amount: 2 },
      { ts: new Date("2026-05-26T03:35:50Z").getTime(), price: 95, amount: 3 },
    ];
    const candles = aggregateTradesToCandles(trades);
    expect(candles).toHaveLength(1);
    expect(candles[0]!.open).toBe(100);
    expect(candles[0]!.close).toBe(95);
    expect(candles[0]!.high).toBe(105);
    expect(candles[0]!.low).toBe(95);
    expect(candles[0]!.volume).toBe(6);
  });

  it("aggregateTradesToCandles: empty input → empty output", () => {
    expect(aggregateTradesToCandles([])).toEqual([]);
  });
});
