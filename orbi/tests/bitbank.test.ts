import { describe, expect, it, vi, beforeEach } from "vitest";
import { BitbankSource, utcDaysCovered } from "../src/sources/bitbank";

// ts in ms. fields are strings except ts.
const SAMPLE_RESPONSE = {
  success: 1,
  data: {
    candlestick: [
      {
        type: "1min",
        ohlcv: [
          ["12000000","12010000","11990000","12005000","0.5", 1779753600000],
          ["12005000","12020000","12000000","12015000","0.7", 1779753660000],
          ["12015000","12030000","12010000","12025000","0.3", 1779753720000],
        ],
      },
    ],
    timestamp: 1779753730000,
  },
};
const SAMPLE_TICKER_OK = { success: 1, data: { last: "12005000" } };

function mockJson(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}

describe("BitbankSource", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("config", () => {
    const s = new BitbankSource();
    expect(s.name).toBe("bitbank");
    expect(s.role).toBe("primary");
    expect(s.rateLimitRps).toBe(1.0);
    expect(s.pairsSupported).toContain("BTC-JPY");
  });

  it("fetch: parses 1min ohlcv tuples in correct order", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_RESPONSE)));
    const s = new BitbankSource();
    const r = await s.fetch({ source: "BTC", target: "JPY" },
      new Date(1779753600000), new Date(1779753720000));
    expect(r.success).toBe(true);
    expect(r.candles).toHaveLength(3);
    expect(r.candles[0]!.open).toBe(12000000);
    expect(r.candles[0]!.high).toBe(12010000);
    expect(r.candles[0]!.low).toBe(11990000);
    expect(r.candles[0]!.close).toBe(12005000);
    expect(r.candles[0]!.volume).toBeCloseTo(0.5);
  });

  it("fetch: filters by window", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_RESPONSE)));
    const s = new BitbankSource();
    const r = await s.fetch({ source: "BTC", target: "JPY" },
      new Date(1779753600000), new Date(1779753660000));
    expect(r.candles).toHaveLength(2);
  });

  it("fetch: success=0 returns success=false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson({ success: 0 })));
    const s = new BitbankSource();
    const r = await s.fetch({ source: "BTC", target: "JPY" }, new Date(), new Date());
    expect(r.success).toBe(false);
  });

  it("fetch: unsupported pair", async () => {
    const s = new BitbankSource();
    const r = await s.fetch({ source: "BTC", target: "USD" }, new Date(), new Date());
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain("unsupported pair");
  });

  it("healthCheck: reachable on valid ticker", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_TICKER_OK)));
    const s = new BitbankSource();
    const h = await s.healthCheck();
    expect(h.reachable).toBe(true);
  });

  it("utcDaysCovered: single day", () => {
    expect(utcDaysCovered(new Date("2026-05-26T01:00:00Z"), new Date("2026-05-26T05:00:00Z"))).toEqual(["20260526"]);
  });

  it("utcDaysCovered: crosses midnight", () => {
    expect(utcDaysCovered(new Date("2026-05-26T23:00:00Z"), new Date("2026-05-27T01:00:00Z"))).toEqual(["20260526", "20260527"]);
  });
});
