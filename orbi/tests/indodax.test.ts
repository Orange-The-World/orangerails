import { describe, expect, it, vi, beforeEach } from "vitest";
import { IndodaxSource } from "../src/sources/indodax";

const SAMPLE_TICKER = {
  ticker: {
    buy: "1310102000",
    high: "1349997000",
    last: "1312277000",
    low: "1310000000",
    sell: "1312277000",
    server_time: 1779938596,
    vol_btc: "20.88",
    vol_idr: "27732087865",
  },
};

function mockJson(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}

describe("IndodaxSource", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("config: identifies as indodax/primary/1 rps/BTC-IDR", () => {
    const s = new IndodaxSource();
    expect(s.name).toBe("indodax");
    expect(s.role).toBe("primary");
    expect(s.rateLimitRps).toBe(1.0);
    expect(s.userAgent).toContain("Mozilla/5.0");
    expect(s.userAgent).toContain("Orange-Rails-ORBI/1.0");
    expect(s.pairsSupported).toEqual(["BTC-IDR"]);
  });

  it("fetch: emits one O=H=L=C candle from ticker", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_TICKER)));
    const s = new IndodaxSource();
    const to = new Date("2026-05-27T12:34:56Z");
    const r = await s.fetch(
      { source: "BTC", target: "IDR" },
      new Date(to.getTime() - 120_000),
      to,
    );
    expect(r.success).toBe(true);
    expect(r.candles).toHaveLength(1);
    const c = r.candles[0]!;
    expect(c.open).toBe(1312277000);
    expect(c.close).toBe(1312277000);
    expect(c.high).toBe(1312277000);
    expect(c.low).toBe(1312277000);
    expect(c.volume).toBe(0);
  });

  it("fetch: unsupported pair returns success=false", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const s = new IndodaxSource();
    const r = await s.fetch({ source: "BTC", target: "USD" }, new Date(), new Date());
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain("unsupported pair BTC-USD");
  });

  it("fetch: missing last surfaces as failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson({ ticker: { buy: "1" } })));
    const s = new IndodaxSource();
    const r = await s.fetch(
      { source: "BTC", target: "IDR" },
      new Date(0),
      new Date(60_000),
    );
    expect(r.success).toBe(false);
  });

  it("healthCheck: reachable on valid ticker", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_TICKER)));
    const s = new IndodaxSource();
    const h = await s.healthCheck();
    expect(h.reachable).toBe(true);
    expect(h.name).toBe("indodax");
  });
});
