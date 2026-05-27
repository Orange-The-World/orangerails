/**
 * Coinbase Exchange source plug-in tests.
 *
 * UNIT tests with mocked HTTP — verify parsing + error handling without real
 * network calls.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { CoinbaseExchangeSource } from "../src/sources/coinbase-exchange";

// Coinbase Exchange tuple: [time_unix_seconds, low, high, open, close, volume]
// Note order CRITICAL — low/high come BEFORE open/close.
// Results are returned most-recent-first in the real API.
const SAMPLE_CANDLES: [number, number, number, number, number, number][] = [
  [1738900120, 97250, 97300, 97265, 97290, 6.05],
  [1738900060, 97200, 97280, 97225, 97265, 12.31],
  [1738900000, 97180, 97250, 97200, 97225, 18.42],
];

const SAMPLE_TICKER_OK = {
  trade_id: 123456,
  price: "97290.00",
  size: "0.01",
  time: "2026-05-26T03:00:00Z",
};

const SAMPLE_TICKER_BAD = { message: "Not Found" };

function mockFetchResponse(jsonBody: unknown, status = 200): Response {
  return new Response(JSON.stringify(jsonBody), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("CoinbaseExchangeSource — unit tests with mocked HTTP", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("config: coinbase_exchange, primary, 1.0 rps, including stablecoin pairs", () => {
    const src = new CoinbaseExchangeSource();
    expect(src.name).toBe("coinbase_exchange");
    expect(src.role).toBe("primary");
    expect(src.rateLimitRps).toBe(1.0);
    expect(src.userAgent).toContain("Orange-Rails-ORBI/1.0");
    expect(src.pairsSupported).toContain("BTC-USD");
    expect(src.pairsSupported).toContain("BTC-EUR");
    expect(src.pairsSupported).toContain("BTC-GBP");
    expect(src.pairsSupported).toContain("BTC-INR");
    expect(src.pairsSupported).toContain("USDT-USD");
    expect(src.pairsSupported).toContain("DAI-USD");
    expect(src.pairsSupported).toContain("PYUSD-USD");
    expect(src.pairsSupported).toContain("EURC-EUR");
    expect(src.pairsSupported).not.toContain("USDC-USD");
    // Coinbase Exchange does NOT list BTC-CAD
    expect(src.pairsSupported).not.toContain("BTC-CAD");
  });

  it("fetch: parses tuple with low/high BEFORE open/close correctly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(SAMPLE_CANDLES)));
    const src = new CoinbaseExchangeSource();
    const result = await src.fetch(
      { source: "BTC", target: "USD" },
      new Date(1738900000 * 1000),
      new Date(1738900200 * 1000),
    );

    expect(result.success).toBe(true);
    expect(result.source).toBe("coinbase_exchange");
    expect(result.candles).toHaveLength(3);
    // CRITICAL: verify low/high/open/close are not swapped
    // Most-recent-first → first tuple is bucket 1738900120
    const c0 = result.candles[0]!;
    expect(c0.bucketTs.getTime()).toBe(1738900120 * 1000);
    expect(c0.low).toBe(97250);
    expect(c0.high).toBe(97300);
    expect(c0.open).toBe(97265);
    expect(c0.close).toBe(97290);
    expect(c0.volume).toBe(6.05);
  });

  it("fetch: works for BTC-INR (the bonus pair that lifts INR from C-composite to B-single)", async () => {
    const inrSample: [number, number, number, number, number, number][] = [
      [1738900060, 8050000, 8060000, 8055000, 8058000, 0.42],
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(inrSample)));
    const src = new CoinbaseExchangeSource();
    const result = await src.fetch(
      { source: "BTC", target: "INR" },
      new Date(1738900000 * 1000),
      new Date(1738900120 * 1000),
    );
    expect(result.success).toBe(true);
    expect(result.candles[0]!.close).toBe(8058000);
  });

  it("fetch: unsupported pair (BTC-CAD) -> success=false", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const src = new CoinbaseExchangeSource();
    const result = await src.fetch({ source: "BTC", target: "CAD" }, new Date(), new Date());
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("unsupported pair BTC-CAD");
  });

  it("fetch: non-array response -> success=false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockFetchResponse({ message: "NotFound" })),
    );
    const src = new CoinbaseExchangeSource();
    const result = await src.fetch(
      { source: "BTC", target: "USD" },
      new Date(1738900000 * 1000),
      new Date(1738900200 * 1000),
    );
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("unexpected response shape");
  });

  it("healthCheck: reachable when ticker returns a positive price", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(SAMPLE_TICKER_OK)));
    const src = new CoinbaseExchangeSource();
    const health = await src.healthCheck();
    expect(health.name).toBe("coinbase_exchange");
    expect(health.reachable).toBe(true);
    expect(health.lastSuccessAt).toBeInstanceOf(Date);
  });

  it("healthCheck: unreachable when ticker is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(SAMPLE_TICKER_BAD)));
    const src = new CoinbaseExchangeSource();
    const health = await src.healthCheck();
    expect(health.reachable).toBe(false);
    expect(health.lastError).toContain("Coinbase Exchange ticker");
  });
});
