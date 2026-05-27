import { describe, expect, it, vi, beforeEach } from "vitest";
import { BitfinexSource } from "../src/sources/bitfinex";

// Bitfinex tuple: [mts, open, close, high, low, volume]
// Note: order CRITICAL — close before high/low (unlike most exchanges)
const SAMPLE_OHLC: [number, number, number, number, number, number][] = [
  [1738900000000, 97200, 97225, 97250, 97180, 18.42],
  [1738900060000, 97225, 97265, 97280, 97200, 12.31],
  [1738900120000, 97265, 97290, 97300, 97250, 6.05],
];

function mockFetchResponse(jsonBody: unknown, status = 200): Response {
  return new Response(JSON.stringify(jsonBody), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("BitfinexSource — unit tests with mocked HTTP", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("config: bitfinex, primary, 0.33 rps", () => {
    const src = new BitfinexSource();
    expect(src.name).toBe("bitfinex");
    expect(src.role).toBe("primary");
    expect(src.rateLimitRps).toBe(0.33);
    expect(src.pairsSupported).toContain("BTC-USD");
    expect(src.pairsSupported).toContain("USDT-USD");
    expect(src.pairsSupported).toContain("USDC-USD");
    expect(src.pairsSupported).toContain("DAI-USD");
  });

  it("fetch: parses tuple with close BEFORE high/low correctly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(SAMPLE_OHLC)));
    const src = new BitfinexSource();
    const result = await src.fetch(
      { source: "BTC", target: "USD" },
      new Date(1738900000000),
      new Date(1738900200000),
    );

    expect(result.success).toBe(true);
    expect(result.candles).toHaveLength(3);
    // CRITICAL: verify close/high/low are not swapped
    expect(result.candles[0]!.open).toBe(97200);
    expect(result.candles[0]!.close).toBe(97225);
    expect(result.candles[0]!.high).toBe(97250);
    expect(result.candles[0]!.low).toBe(97180);
    expect(result.candles[0]!.volume).toBe(18.42);
  });

  it("fetch: unsupported pair → success=false", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const src = new BitfinexSource();
    const result = await src.fetch({ source: "BTC", target: "EUR" }, new Date(), new Date());
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("unsupported pair");
  });

  it("fetch: non-array response → success=false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ error: "something" })));
    const src = new BitfinexSource();
    const result = await src.fetch(
      { source: "BTC", target: "USD" },
      new Date(1738900000000),
      new Date(1738900200000),
    );
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("unexpected response shape");
  });

  it("healthCheck: reachable when platform status returns [1]", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse([1])));
    const src = new BitfinexSource();
    const health = await src.healthCheck();
    expect(health.reachable).toBe(true);
  });

  it("healthCheck: unreachable when platform status returns [0]", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse([0])));
    const src = new BitfinexSource();
    const health = await src.healthCheck();
    expect(health.reachable).toBe(false);
    expect(health.lastError).toContain("platform status");
  });
});
