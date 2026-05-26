import { describe, expect, it, vi, beforeEach } from "vitest";
import { IndependentReserveSource } from "../src/sources/independent-reserve";

const SAMPLE_TRADES = {
  Trades: [
    { TradeTimestampUtc: "2026-05-26T22:00:30Z", PrimaryCurrencyAmount: 0.5, SecondaryCurrencyTradePrice: 105000, TradeGuid: "a", Taker: "Bid" },
    { TradeTimestampUtc: "2026-05-26T22:00:45Z", PrimaryCurrencyAmount: 0.3, SecondaryCurrencyTradePrice: 105100, TradeGuid: "b", Taker: "Bid" },
    { TradeTimestampUtc: "2026-05-26T22:01:10Z", PrimaryCurrencyAmount: 0.2, SecondaryCurrencyTradePrice: 104900, TradeGuid: "c", Taker: "Offer" },
  ],
};
const SAMPLE_SUMMARY = { LastPrice: 105000 };

function mockJson(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}

describe("IndependentReserveSource", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("config", () => {
    const s = new IndependentReserveSource();
    expect(s.name).toBe("independent_reserve");
    expect(s.role).toBe("primary");
    expect(s.pairsSupported).toEqual(["BTC-AUD"]);
  });

  it("fetch: aggregates trades to 2 minute buckets", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_TRADES)));
    const s = new IndependentReserveSource();
    const r = await s.fetch({ source: "BTC", target: "AUD" },
      new Date("2026-05-26T22:00:00Z"), new Date("2026-05-26T22:02:00Z"));
    expect(r.success).toBe(true);
    expect(r.candles).toHaveLength(2);
    expect(r.candles[0]!.high).toBe(105100);
    expect(r.candles[0]!.low).toBe(105000);
    expect(r.candles[0]!.volume).toBeCloseTo(0.8);
  });

  it("fetch: unsupported pair", async () => {
    const s = new IndependentReserveSource();
    const r = await s.fetch({ source: "BTC", target: "USD" }, new Date(), new Date());
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain("unsupported pair");
  });

  it("fetch: empty trades returns success=true, no candles", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson({ Trades: [] })));
    const s = new IndependentReserveSource();
    const r = await s.fetch({ source: "BTC", target: "AUD" }, new Date(), new Date());
    expect(r.success).toBe(true);
    expect(r.candles).toEqual([]);
  });

  it("healthCheck: reachable on market summary", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_SUMMARY)));
    const s = new IndependentReserveSource();
    const h = await s.healthCheck();
    expect(h.reachable).toBe(true);
  });
});
