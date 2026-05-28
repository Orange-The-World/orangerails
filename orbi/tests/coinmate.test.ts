import { describe, expect, it, vi, beforeEach } from "vitest";
import { CoinmateSource } from "../src/sources/coinmate";

const T0_MS = 1779938400_000;
const SAMPLE_TRADES = {
  error: false,
  errorMessage: null,
  data: [
    { timestamp: T0_MS + 5_000, transactionId: 1, price: 1544000, amount: 0.5, currencyPair: "BTC_CZK", tradeType: "BUY" },
    { timestamp: T0_MS + 40_000, transactionId: 2, price: 1545000, amount: 0.3, currencyPair: "BTC_CZK", tradeType: "SELL" },
  ],
};
const SAMPLE_TICKER = {
  error: false,
  errorMessage: null,
  data: { last: 1544401, high: 1585701, low: 1541654, amount: 8.38, bid: 1544692, ask: 1545949, status: "TRADING" },
};

function mockJson(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}

describe("CoinmateSource", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("config: identifies as coinmate/primary/1 rps/BTC-CZK+BTC-EUR", () => {
    const s = new CoinmateSource();
    expect(s.name).toBe("coinmate");
    expect(s.role).toBe("primary");
    expect(s.rateLimitRps).toBe(1.0);
    expect(s.pairsSupported).toContain("BTC-CZK");
    expect(s.pairsSupported).toContain("BTC-EUR");
  });

  it("fetch: aggregates transactions into OHLC", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_TRADES)));
    const s = new CoinmateSource();
    const r = await s.fetch(
      { source: "BTC", target: "CZK" },
      new Date(T0_MS),
      new Date(T0_MS + 120_000),
    );
    expect(r.success).toBe(true);
    expect(r.candles.length).toBeGreaterThanOrEqual(1);
    expect(r.candles[0]!.open).toBe(1544000);
  });

  it("fetch: unsupported pair returns success=false", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const s = new CoinmateSource();
    const r = await s.fetch({ source: "BTC", target: "USD" }, new Date(), new Date());
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain("unsupported pair BTC-USD");
  });

  it("fetch: error=true in response surfaces as failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson({ error: true, errorMessage: "boom", data: null })));
    const s = new CoinmateSource();
    const r = await s.fetch(
      { source: "BTC", target: "CZK" },
      new Date(T0_MS),
      new Date(T0_MS + 60_000),
    );
    expect(r.success).toBe(false);
  });

  it("healthCheck: reachable on TRADING status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_TICKER)));
    const s = new CoinmateSource();
    const h = await s.healthCheck();
    expect(h.reachable).toBe(true);
  });

  it("healthCheck: unreachable on HALTED status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockJson({ error: false, data: { last: 1, status: "HALTED" } })),
    );
    const s = new CoinmateSource();
    const h = await s.healthCheck();
    expect(h.reachable).toBe(false);
  });
});
