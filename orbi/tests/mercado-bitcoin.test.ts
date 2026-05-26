import { describe, expect, it, vi, beforeEach } from "vitest";
import { MercadoBitcoinSource } from "../src/sources/mercado-bitcoin";

const SAMPLE_CANDLES = {
  t: [1738900000, 1738900060, 1738900120],
  o: ["576920", "577100", "577250"],
  h: ["577200", "577300", "577400"],
  l: ["576900", "577050", "577200"],
  c: ["577100", "577250", "577380"],
  v: ["1.2", "0.8", "0.5"],
};

const SAMPLE_SYMBOLS = { symbol: ["BTC-BRL", "ETH-BRL", "USDT-BRL"] };

function mockFetchResponse(jsonBody: unknown, status = 200): Response {
  return new Response(JSON.stringify(jsonBody), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("MercadoBitcoinSource — unit tests", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("config: mercado_bitcoin, primary, 1 rps, BRL pairs", () => {
    const src = new MercadoBitcoinSource();
    expect(src.name).toBe("mercado_bitcoin");
    expect(src.role).toBe("primary");
    expect(src.rateLimitRps).toBe(1.0);
    expect(src.pairsSupported).toContain("BTC-BRL");
    expect(src.pairsSupported).toContain("BTC-USDT");
  });

  it("fetch: parses TradingView UDF candles correctly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(SAMPLE_CANDLES)));
    const src = new MercadoBitcoinSource();
    const result = await src.fetch(
      { source: "BTC", target: "BRL" },
      new Date(1738900000 * 1000),
      new Date(1738900200 * 1000),
    );
    expect(result.success).toBe(true);
    expect(result.candles).toHaveLength(3);
    expect(result.candles[0]!.open).toBe(576920);
    expect(result.candles[0]!.close).toBe(577100);
    expect(result.candles[0]!.high).toBe(577200);
    expect(result.candles[0]!.low).toBe(576900);
    expect(result.candles[0]!.volume).toBe(1.2);
  });

  it("fetch: unsupported pair → success=false", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const src = new MercadoBitcoinSource();
    const result = await src.fetch({ source: "BTC", target: "MXN" }, new Date(), new Date());
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("unsupported pair");
  });

  it("fetch: missing required arrays → success=false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ t: [], o: [] })));
    const src = new MercadoBitcoinSource();
    const result = await src.fetch(
      { source: "BTC", target: "BRL" },
      new Date(1738900000 * 1000),
      new Date(1738900200 * 1000),
    );
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("unexpected response shape");
  });

  it("healthCheck: reachable when symbols endpoint returns non-empty array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(SAMPLE_SYMBOLS)));
    const src = new MercadoBitcoinSource();
    const health = await src.healthCheck();
    expect(health.reachable).toBe(true);
  });

  it("healthCheck: unreachable when symbols endpoint malformed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({})));
    const src = new MercadoBitcoinSource();
    const health = await src.healthCheck();
    expect(health.reachable).toBe(false);
  });
});
