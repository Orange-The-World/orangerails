import { describe, expect, it, vi, beforeEach } from "vitest";
import { CoincheckSource } from "../src/sources/coincheck";

const SAMPLE_TRADES = {
  success: true,
  data: [
    { id: 1, amount: "0.5", rate: "12000000", pair: "btc_jpy", order_type: "buy",  created_at: "2026-05-26T00:00:30Z" },
    { id: 2, amount: "0.3", rate: "12010000", pair: "btc_jpy", order_type: "sell", created_at: "2026-05-26T00:00:45Z" },
    { id: 3, amount: "0.2", rate: "11990000", pair: "btc_jpy", order_type: "buy",  created_at: "2026-05-26T00:01:10Z" },
  ],
  pagination: {},
};
const SAMPLE_TICKER = { last: 12000000, bid: 11999000, ask: 12001000, high: 0, low: 0, volume: 1, timestamp: 0 };

function mockJson(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}

describe("CoincheckSource", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("config: identifies as coincheck/primary/1 rps/BTC-JPY only", () => {
    const s = new CoincheckSource();
    expect(s.name).toBe("coincheck");
    expect(s.role).toBe("primary");
    expect(s.rateLimitRps).toBe(1.0);
    expect(s.userAgent).toContain("Orange-Rails-ORBI/1.0");
    expect(s.pairsSupported).toEqual(["BTC-JPY"]);
  });

  it("fetch: aggregates trades into per-minute OHLC", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_TRADES)));
    const s = new CoincheckSource();
    const r = await s.fetch({ source: "BTC", target: "JPY" },
      new Date("2026-05-26T00:00:00Z"), new Date("2026-05-26T00:02:00Z"));
    expect(r.success).toBe(true);
    expect(r.candles).toHaveLength(2);
    // first bucket: trades id 1,2; open=12000000, close=12010000, high=12010000, low=12000000, vol=0.8
    expect(r.candles[0]!.open).toBe(12000000);
    expect(r.candles[0]!.close).toBe(12010000);
    expect(r.candles[0]!.high).toBe(12010000);
    expect(r.candles[0]!.low).toBe(12000000);
    expect(r.candles[0]!.volume).toBeCloseTo(0.8);
    // second bucket: trade id 3 only
    expect(r.candles[1]!.close).toBe(11990000);
    expect(r.candles[1]!.volume).toBeCloseTo(0.2);
  });

  it("fetch: unsupported pair returns success=false", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const s = new CoincheckSource();
    const r = await s.fetch({ source: "BTC", target: "USD" }, new Date(), new Date());
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain("unsupported pair BTC-USD");
  });

  it("fetch: filters trades outside [from,to]", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_TRADES)));
    const s = new CoincheckSource();
    const r = await s.fetch({ source: "BTC", target: "JPY" },
      new Date("2026-05-26T00:01:00Z"), new Date("2026-05-26T00:02:00Z"));
    expect(r.success).toBe(true);
    expect(r.candles).toHaveLength(1);
    expect(r.candles[0]!.volume).toBeCloseTo(0.2);
  });

  it("healthCheck: returns reachable on valid ticker", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_TICKER)));
    const s = new CoincheckSource();
    const h = await s.healthCheck();
    expect(h.reachable).toBe(true);
    expect(h.name).toBe("coincheck");
  });

  it("healthCheck: unreachable on missing last", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson({ bid: 0 })));
    const s = new CoincheckSource();
    const h = await s.healthCheck();
    expect(h.reachable).toBe(false);
  });
});
