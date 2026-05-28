import { describe, expect, it, vi, beforeEach } from "vitest";
import { BitkubSource } from "../src/sources/bitkub";

const T0 = 1779938400; // unix seconds
const SAMPLE_TRADES = {
  error: 0,
  result: [
    [T0 + 30, 2410000, 0.5, "BUY"],
    [T0 + 45, 2411000, 0.3, "SELL"],
    [T0 + 75, 2409000, 0.2, "BUY"],
  ],
};
const SAMPLE_TICKER = [{ symbol: "BTC_THB", last: "2410018.78", base_volume: "99.20" }];

function mockJson(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}

describe("BitkubSource", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("config: identifies as bitkub/primary/1 rps/BTC-THB", () => {
    const s = new BitkubSource();
    expect(s.name).toBe("bitkub");
    expect(s.role).toBe("primary");
    expect(s.rateLimitRps).toBe(1.0);
    expect(s.userAgent).toContain("Orange-Rails-ORBI/1.0");
    expect(s.pairsSupported).toEqual(["BTC-THB"]);
  });

  it("fetch: aggregates trades into per-minute OHLC", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_TRADES)));
    const s = new BitkubSource();
    const r = await s.fetch(
      { source: "BTC", target: "THB" },
      new Date(T0 * 1000),
      new Date((T0 + 120) * 1000),
    );
    expect(r.success).toBe(true);
    expect(r.candles.length).toBeGreaterThanOrEqual(1);
    expect(r.candles[0]!.open).toBe(2410000);
  });

  it("fetch: unsupported pair returns success=false", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const s = new BitkubSource();
    const r = await s.fetch({ source: "BTC", target: "USD" }, new Date(), new Date());
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain("unsupported pair BTC-USD");
  });

  it("fetch: error != 0 in response surfaces as failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson({ error: 99, result: null })));
    const s = new BitkubSource();
    const r = await s.fetch(
      { source: "BTC", target: "THB" },
      new Date(T0 * 1000),
      new Date((T0 + 120) * 1000),
    );
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain("error=99");
  });

  it("healthCheck: reachable on valid ticker", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_TICKER)));
    const s = new BitkubSource();
    const h = await s.healthCheck();
    expect(h.reachable).toBe(true);
    expect(h.name).toBe("bitkub");
  });

  it("healthCheck: unreachable on missing last", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson([])));
    const s = new BitkubSource();
    const h = await s.healthCheck();
    expect(h.reachable).toBe(false);
  });
});
