import { describe, expect, it, vi, beforeEach } from "vitest";
import { BithumbSource } from "../src/sources/bithumb";

// Order: [ts_ms, OPEN, CLOSE, HIGH, LOW, VOLUME]
const SAMPLE_CANDLESTICK = {
  status: "0000",
  data: [
    [1779753600000, "112000000", "112050000", "112100000", "111950000", "0.5"],
    [1779753660000, "112050000", "112150000", "112200000", "112050000", "0.7"],
    [1779753720000, "112150000", "112100000", "112200000", "112050000", "0.3"],
  ],
};
const SAMPLE_TICKER = { status: "0000", data: { closing_price: "112000000" } };

function mockJson(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}

describe("BithumbSource", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("config", () => {
    const s = new BithumbSource();
    expect(s.name).toBe("bithumb");
    expect(s.pairsSupported).toEqual(["BTC-KRW"]);
  });

  it("fetch: parses with TS,O,C,H,L,V order (NOT OHLC!)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_CANDLESTICK)));
    const s = new BithumbSource();
    const r = await s.fetch({ source: "BTC", target: "KRW" },
      new Date(1779753600000), new Date(1779753720000));
    expect(r.success).toBe(true);
    expect(r.candles).toHaveLength(3);
    // First row: open=112M, close=112.05M, high=112.1M, low=111.95M
    expect(r.candles[0]!.open).toBe(112000000);
    expect(r.candles[0]!.close).toBe(112050000);
    expect(r.candles[0]!.high).toBe(112100000);
    expect(r.candles[0]!.low).toBe(111950000);
    expect(r.candles[0]!.volume).toBeCloseTo(0.5);
  });

  it("fetch: status != 0000 returns success=false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson({ status: "5500" })));
    const s = new BithumbSource();
    const r = await s.fetch({ source: "BTC", target: "KRW" }, new Date(), new Date());
    expect(r.success).toBe(false);
  });

  it("fetch: unsupported pair", async () => {
    const s = new BithumbSource();
    const r = await s.fetch({ source: "BTC", target: "USD" }, new Date(), new Date());
    expect(r.success).toBe(false);
  });

  it("healthCheck: reachable on closing_price>0", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_TICKER)));
    const s = new BithumbSource();
    const h = await s.healthCheck();
    expect(h.reachable).toBe(true);
  });
});
