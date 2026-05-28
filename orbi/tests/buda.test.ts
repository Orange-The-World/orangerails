import { describe, expect, it, vi, beforeEach } from "vitest";
import { BudaSource } from "../src/sources/buda";

const T0_MS = 1779938400_000;
const SAMPLE_TRADES = {
  trades: {
    market_id: "BTC-CLP",
    timestamp: null,
    last_timestamp: String(T0_MS + 60_000),
    entries: [
      [String(T0_MS + 5_000), "0.00061058", "66102000.0", "sell", 9814136],
      [String(T0_MS + 40_000), "0.00014903", "66168973.0", "buy", 9814135],
      [String(T0_MS + 75_000), "0.03776435", "66200000.0", "sell", 9814134],
    ],
  },
};
const SAMPLE_TICKER = {
  ticker: {
    market_id: "BTC-CLP",
    last_price: ["66102000.0", "CLP"],
    min_ask: ["66166960.0", "CLP"],
    max_bid: ["66102000.0", "CLP"],
    volume: ["2.16879583", "BTC"],
  },
};

function mockJson(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}

describe("BudaSource", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("config: identifies as buda/primary/1 rps/BTC-CLP+COP+PEN", () => {
    const s = new BudaSource();
    expect(s.name).toBe("buda");
    expect(s.role).toBe("primary");
    expect(s.rateLimitRps).toBe(1.0);
    expect(s.pairsSupported).toEqual(["BTC-CLP", "BTC-COP", "BTC-PEN"]);
  });

  it("fetch: aggregates entries into OHLC across minute buckets", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_TRADES)));
    const s = new BudaSource();
    const r = await s.fetch(
      { source: "BTC", target: "CLP" },
      new Date(T0_MS),
      new Date(T0_MS + 120_000),
    );
    expect(r.success).toBe(true);
    expect(r.candles.length).toBeGreaterThanOrEqual(1);
    // First bucket: first two entries; open=66102000 close=66168973
    expect(r.candles[0]!.open).toBe(66102000);
  });

  it("fetch: unsupported pair returns success=false", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const s = new BudaSource();
    const r = await s.fetch({ source: "BTC", target: "USD" }, new Date(), new Date());
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain("unsupported pair BTC-USD");
  });

  it("fetch: filters out trades outside [from,to]", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_TRADES)));
    const s = new BudaSource();
    const r = await s.fetch(
      { source: "BTC", target: "CLP" },
      new Date(T0_MS + 60_000),
      new Date(T0_MS + 120_000),
    );
    expect(r.success).toBe(true);
    // Only the third entry (ts=T0+75s) falls in this window.
    expect(r.candles).toHaveLength(1);
    expect(r.candles[0]!.close).toBe(66200000);
  });

  it("healthCheck: reachable on valid ticker", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_TICKER)));
    const s = new BudaSource();
    const h = await s.healthCheck();
    expect(h.reachable).toBe(true);
    expect(h.name).toBe("buda");
  });

  it("healthCheck: unreachable on missing last_price", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson({ ticker: {} })));
    const s = new BudaSource();
    const h = await s.healthCheck();
    expect(h.reachable).toBe(false);
  });
});
