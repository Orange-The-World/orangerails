import { describe, expect, it, vi, beforeEach } from "vitest";
import { RipioSource } from "../src/sources/ripio";

const SAMPLE_RATES = [
  { ticker: "WARS_ARS", buy_rate: "1", sell_rate: "1", variation: "0" },
  { ticker: "BTC_ARS", buy_rate: "113000000", sell_rate: "109000000", variation: "-1.83" },
  { ticker: "BTC_USD", buy_rate: "76000", sell_rate: "75500", variation: "-1.95" },
];

function mockJson(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}

describe("RipioSource", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("config", () => {
    const s = new RipioSource();
    expect(s.name).toBe("ripio");
    expect(s.pairsSupported).toEqual(["BTC-ARS"]);
  });

  it("fetch: emits one mid-price zero-volume candle", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_RATES)));
    const s = new RipioSource();
    const r = await s.fetch({ source: "BTC", target: "ARS" },
      new Date("2026-05-26T22:00:00Z"), new Date("2026-05-26T22:35:30Z"));
    expect(r.success).toBe(true);
    expect(r.candles).toHaveLength(1);
    expect(r.candles[0]!.close).toBe(111000000); // (113M + 109M) / 2
    expect(r.candles[0]!.volume).toBe(0);
  });

  it("fetch: missing BTC_ARS returns success=false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson([])));
    const s = new RipioSource();
    const r = await s.fetch({ source: "BTC", target: "ARS" }, new Date(), new Date());
    expect(r.success).toBe(false);
  });

  it("fetch: unsupported pair", async () => {
    const s = new RipioSource();
    const r = await s.fetch({ source: "BTC", target: "USD" }, new Date(), new Date());
    expect(r.success).toBe(false);
  });

  it("healthCheck: reachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_RATES)));
    const s = new RipioSource();
    const h = await s.healthCheck();
    expect(h.reachable).toBe(true);
  });
});
