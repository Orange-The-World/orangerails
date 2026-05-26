import { describe, expect, it, vi, beforeEach } from "vitest";
import { BtcMarketsSource } from "../src/sources/btc-markets";

const SAMPLE_CANDLES = [
  ["2026-05-26T22:30:00.000Z","105000","105100","104900","105050","0.5"],
  ["2026-05-26T22:31:00.000Z","105050","105200","105000","105150","0.8"],
];
const SAMPLE_TICKER = { marketId: "BTC-AUD", lastPrice: "105100" };

function mockJson(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}

describe("BtcMarketsSource", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("config", () => {
    const s = new BtcMarketsSource();
    expect(s.name).toBe("btc_markets");
    expect(s.pairsSupported).toEqual(["BTC-AUD"]);
  });

  it("fetch: parses candle rows in TS,O,H,L,C,V order", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_CANDLES)));
    const s = new BtcMarketsSource();
    const r = await s.fetch({ source: "BTC", target: "AUD" },
      new Date("2026-05-26T22:30:00Z"), new Date("2026-05-26T22:31:00Z"));
    expect(r.success).toBe(true);
    expect(r.candles).toHaveLength(2);
    expect(r.candles[0]!.open).toBe(105000);
    expect(r.candles[0]!.high).toBe(105100);
    expect(r.candles[0]!.low).toBe(104900);
    expect(r.candles[0]!.close).toBe(105050);
    expect(r.candles[0]!.volume).toBeCloseTo(0.5);
  });

  it("fetch: non-array response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson({ error: "x" })));
    const s = new BtcMarketsSource();
    const r = await s.fetch({ source: "BTC", target: "AUD" }, new Date(), new Date());
    expect(r.success).toBe(false);
  });

  it("fetch: unsupported pair", async () => {
    const s = new BtcMarketsSource();
    const r = await s.fetch({ source: "BTC", target: "USD" }, new Date(), new Date());
    expect(r.success).toBe(false);
  });

  it("healthCheck: reachable on lastPrice>0", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_TICKER)));
    const s = new BtcMarketsSource();
    const h = await s.healthCheck();
    expect(h.reachable).toBe(true);
  });
});
