import { describe, expect, it, vi, beforeEach } from "vitest";
import { ParibuSource } from "../src/sources/paribu";

const SAMPLE_TICKER = {
  BTC_TL: { lowestAsk: 3479361, highestBid: 3477734, low24hr: 3474422, high24hr: 3567218, avg24hr: 3514944, volume: 67.13, last: 3477505, change: -50860, percentChange: -1.44, chartData: [] },
  ETH_TL: { last: 100000 },
};

function mockJson(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}

describe("ParibuSource", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("config", () => {
    const s = new ParibuSource();
    expect(s.name).toBe("paribu");
    expect(s.pairsSupported).toEqual(["BTC-TRY"]);
  });

  it("fetch: emits one zero-volume candle from BTC_TL.last", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_TICKER)));
    const s = new ParibuSource();
    const to = new Date("2026-05-26T22:35:30Z");
    const r = await s.fetch({ source: "BTC", target: "TRY" }, new Date("2026-05-26T22:00:00Z"), to);
    expect(r.success).toBe(true);
    expect(r.candles).toHaveLength(1);
    expect(r.candles[0]!.open).toBe(3477505);
    expect(r.candles[0]!.close).toBe(3477505);
    expect(r.candles[0]!.volume).toBe(0);
    // Bucket snapped to minute floor before `to` (22:34:00)
    expect(r.candles[0]!.bucketTs.toISOString()).toBe("2026-05-26T22:34:00.000Z");
  });

  it("fetch: missing BTC_TL returns success=false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson({})));
    const s = new ParibuSource();
    const r = await s.fetch({ source: "BTC", target: "TRY" }, new Date(), new Date());
    expect(r.success).toBe(false);
  });

  it("fetch: unsupported pair", async () => {
    const s = new ParibuSource();
    const r = await s.fetch({ source: "BTC", target: "USD" }, new Date(), new Date());
    expect(r.success).toBe(false);
  });

  it("healthCheck: reachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_TICKER)));
    const s = new ParibuSource();
    const h = await s.healthCheck();
    expect(h.reachable).toBe(true);
  });
});
