/**
 * Kraken source plug-in tests.
 *
 * These are UNIT tests with mocked HTTP — they verify the plug-in's parsing
 * and error handling without making real network calls. A separate
 * `kraken-live.test.ts` (excluded from CI default) hits the real Kraken API.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { KrakenSource } from "../src/sources/kraken";

// Sample real Kraken response shape (one minute of XBTUSD).
const SAMPLE_OHLC_RESPONSE = {
  error: [],
  result: {
    XXBTZUSD: [
      // [time, open, high, low, close, vwap, volume, count]
      [1738900000, "97200.0", "97250.0", "97180.0", "97225.0", "97215.0", "18.42", 142],
      [1738900060, "97225.0", "97280.0", "97200.0", "97265.0", "97250.0", "12.31", 88],
      [1738900120, "97265.0", "97300.0", "97250.0", "97290.0", "97275.0", "6.05", 51],
    ],
    last: 1738900120,
  },
};

const SAMPLE_STATUS_OK = {
  error: [],
  result: { status: "online", timestamp: "2026-05-26T03:00:00Z" },
};

const SAMPLE_STATUS_MAINTENANCE = {
  error: [],
  result: { status: "maintenance", timestamp: "2026-05-26T03:00:00Z" },
};

function mockFetchResponse(jsonBody: unknown, status = 200): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  return new Response(JSON.stringify(jsonBody), { status, headers });
}

describe("KrakenSource — unit tests with mocked HTTP", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("config: identifies itself as kraken, primary, 0.5 rps", () => {
    const src = new KrakenSource();
    expect(src.name).toBe("kraken");
    expect(src.role).toBe("primary");
    expect(src.rateLimitRps).toBe(0.5);
    expect(src.userAgent).toContain("Orange-Rails-ORBI/1.0");
    expect(src.pairsSupported).toContain("BTC-USD");
    expect(src.pairsSupported).toContain("BTC-CAD");
    expect(src.pairsSupported).toContain("USDT-USD");
  });

  it("fetch: returns parsed candles for BTC/USD on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(SAMPLE_OHLC_RESPONSE)));

    const src = new KrakenSource();
    const result = await src.fetch(
      { source: "BTC", target: "USD" },
      new Date(1738900000 * 1000),
      new Date(1738900200 * 1000),
    );

    expect(result.success).toBe(true);
    expect(result.source).toBe("kraken");
    expect(result.candles).toHaveLength(3);
    expect(result.candles[0]!.close).toBe(97225.0);
    expect(result.candles[0]!.volume).toBe(18.42);
    expect(result.candles[1]!.close).toBe(97265.0);
    expect(result.errorMessage).toBeUndefined();
  });

  it("fetch: returns success=false when Kraken reports an API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockFetchResponse({ error: ["EAPI:Rate limit exceeded"], result: {} }),
      ),
    );

    const src = new KrakenSource();
    const result = await src.fetch(
      { source: "BTC", target: "USD" },
      new Date(1738900000 * 1000),
      new Date(1738900200 * 1000),
    );

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("Rate limit exceeded");
    expect(result.candles).toEqual([]);
  });

  it("fetch: returns success=false for an unsupported pair", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const src = new KrakenSource();
    const result = await src.fetch(
      { source: "BTC", target: "MXN" },  // Kraken doesn't quote MXN
      new Date(),
      new Date(),
    );
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("unsupported pair BTC-MXN");
  });

  it("fetch: filters candles past the `to` window", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(SAMPLE_OHLC_RESPONSE)));

    const src = new KrakenSource();
    const result = await src.fetch(
      { source: "BTC", target: "USD" },
      new Date(1738900000 * 1000),
      new Date(1738900060 * 1000), // only first 60 sec — includes first 2 candles
    );

    expect(result.success).toBe(true);
    // Second candle's ts is 1738900060 which is == to; we include it (<= to)
    expect(result.candles).toHaveLength(2);
  });

  it("healthCheck: returns reachable=true when Kraken reports online", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(SAMPLE_STATUS_OK)));

    const src = new KrakenSource();
    const health = await src.healthCheck();

    expect(health.name).toBe("kraken");
    expect(health.reachable).toBe(true);
    expect(health.lastSuccessAt).toBeInstanceOf(Date);
  });

  it("healthCheck: returns reachable=false when Kraken is in maintenance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(SAMPLE_STATUS_MAINTENANCE)));

    const src = new KrakenSource();
    const health = await src.healthCheck();

    expect(health.reachable).toBe(false);
    expect(health.lastError).toContain("maintenance");
  });
});
