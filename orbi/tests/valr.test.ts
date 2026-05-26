import { describe, expect, it, vi, beforeEach } from "vitest";
import { ValrSource } from "../src/sources/valr";

const SAMPLE_TRADES = [
  { price: "1252479", quantity: "0.5",  currencyPair: "BTCZAR", tradedAt: "2026-05-26T22:00:30Z", takerSide: "sell" },
  { price: "1253000", quantity: "0.3",  currencyPair: "BTCZAR", tradedAt: "2026-05-26T22:00:45Z", takerSide: "buy"  },
  { price: "1251000", quantity: "0.2",  currencyPair: "BTCZAR", tradedAt: "2026-05-26T22:01:10Z", takerSide: "sell" },
];
const SAMPLE_SUMMARY = { lastTradedPrice: "1252479" };

function mockJson(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}

describe("ValrSource", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("config", () => {
    const s = new ValrSource();
    expect(s.name).toBe("valr");
    expect(s.pairsSupported).toEqual(["BTC-ZAR"]);
  });

  it("fetch: aggregates BTCZAR trades to OHLC", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_TRADES)));
    const s = new ValrSource();
    const r = await s.fetch({ source: "BTC", target: "ZAR" },
      new Date("2026-05-26T22:00:00Z"), new Date("2026-05-26T22:02:00Z"));
    expect(r.success).toBe(true);
    expect(r.candles).toHaveLength(2);
    expect(r.candles[0]!.high).toBe(1253000);
    expect(r.candles[0]!.low).toBe(1252479);
    expect(r.candles[0]!.volume).toBeCloseTo(0.8);
  });

  it("fetch: unsupported pair", async () => {
    const s = new ValrSource();
    const r = await s.fetch({ source: "BTC", target: "USD" }, new Date(), new Date());
    expect(r.success).toBe(false);
  });

  it("fetch: non-array trades", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson({ err: "x" })));
    const s = new ValrSource();
    const r = await s.fetch({ source: "BTC", target: "ZAR" }, new Date(), new Date());
    expect(r.success).toBe(false);
  });

  it("healthCheck: reachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_SUMMARY)));
    const s = new ValrSource();
    const h = await s.healthCheck();
    expect(h.reachable).toBe(true);
  });
});
