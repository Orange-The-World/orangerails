import { describe, expect, it, vi, beforeEach } from "vitest";
import { LunoSource } from "../src/sources/luno";

const SAMPLE_TICKER = {
  pair: "XBTZAR", timestamp: 1779834947921, bid: "1252820.00", ask: "1252957.00",
  last_trade: "1252685.00", rolling_24_hour_volume: "44.93", status: "ACTIVE",
};

function mockJson(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}

describe("LunoSource", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("config", () => {
    const s = new LunoSource();
    expect(s.name).toBe("luno");
    expect(s.pairsSupported).toEqual(["BTC-ZAR", "BTC-MYR"]);
  });

  it("fetch: supports BTC-MYR via the same ticker shape", async () => {
    const myr = {
      pair: "XBTMYR", timestamp: 1779938598317, bid: "295481.00", ask: "295691.00",
      last_trade: "295695.00", rolling_24_hour_volume: "14.12", status: "ACTIVE",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(myr)));
    const s = new LunoSource();
    const r = await s.fetch({ source: "BTC", target: "MYR" },
      new Date("2026-05-27T00:00:00Z"), new Date("2026-05-27T00:01:30Z"));
    expect(r.success).toBe(true);
    expect(r.candles).toHaveLength(1);
    expect(r.candles[0]!.close).toBe(295695);
    expect(r.candles[0]!.volume).toBe(0);
  });

  it("fetch: emits one zero-volume candle from last_trade", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_TICKER)));
    const s = new LunoSource();
    const r = await s.fetch({ source: "BTC", target: "ZAR" },
      new Date("2026-05-26T22:00:00Z"), new Date("2026-05-26T22:35:30Z"));
    expect(r.success).toBe(true);
    expect(r.candles).toHaveLength(1);
    expect(r.candles[0]!.close).toBe(1252685);
    expect(r.candles[0]!.volume).toBe(0);
  });

  it("fetch: unsupported pair", async () => {
    const s = new LunoSource();
    const r = await s.fetch({ source: "BTC", target: "USD" }, new Date(), new Date());
    expect(r.success).toBe(false);
  });

  it("fetch: zero last_trade returns success=false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson({ last_trade: "0" })));
    const s = new LunoSource();
    const r = await s.fetch({ source: "BTC", target: "ZAR" }, new Date(), new Date());
    expect(r.success).toBe(false);
  });

  it("healthCheck: reachable on ACTIVE status + last_trade>0", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_TICKER)));
    const s = new LunoSource();
    const h = await s.healthCheck();
    expect(h.reachable).toBe(true);
  });
});
