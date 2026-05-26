import { describe, expect, it, vi, beforeEach } from "vitest";
import { BitstampSource } from "../src/sources/bitstamp";

const SAMPLE_OHLC = {
  data: {
    pair: "BTC/USD",
    ohlc: [
      { timestamp: "1738900000", open: "97200", high: "97250", low: "97180", close: "97225", volume: "18.42" },
      { timestamp: "1738900060", open: "97225", high: "97280", low: "97200", close: "97265", volume: "12.31" },
      { timestamp: "1738900120", open: "97265", high: "97300", low: "97250", close: "97290", volume: "6.05" },
    ],
  },
};

const SAMPLE_TICKER_OK = { last: "97225.50", bid: "97224.00", ask: "97225.00" };

function mockFetchResponse(jsonBody: unknown, status = 200): Response {
  return new Response(JSON.stringify(jsonBody), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("BitstampSource — unit tests with mocked HTTP", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("config: identifies as bitstamp, primary, 2 rps", () => {
    const src = new BitstampSource();
    expect(src.name).toBe("bitstamp");
    expect(src.role).toBe("primary");
    expect(src.rateLimitRps).toBe(2.0);
    expect(src.pairsSupported).toEqual(["BTC-USD", "BTC-EUR", "BTC-GBP"]);
  });

  it("fetch: returns parsed BTC/USD candles", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(SAMPLE_OHLC)));
    const src = new BitstampSource();
    const result = await src.fetch(
      { source: "BTC", target: "USD" },
      new Date(1738900000 * 1000),
      new Date(1738900200 * 1000),
    );
    expect(result.success).toBe(true);
    expect(result.candles).toHaveLength(3);
    expect(result.candles[0]!.close).toBe(97225);
    expect(result.candles[0]!.volume).toBe(18.42);
  });

  it("fetch: filters past the `to` window", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(SAMPLE_OHLC)));
    const src = new BitstampSource();
    const result = await src.fetch(
      { source: "BTC", target: "USD" },
      new Date(1738900000 * 1000),
      new Date(1738900060 * 1000),
    );
    expect(result.candles).toHaveLength(2); // first two only
  });

  it("fetch: unsupported pair (BTC-MXN) → success=false", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const src = new BitstampSource();
    const result = await src.fetch({ source: "BTC", target: "MXN" }, new Date(), new Date());
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("unsupported pair");
  });

  it("fetch: missing data.ohlc → success=false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ data: {} })));
    const src = new BitstampSource();
    const result = await src.fetch(
      { source: "BTC", target: "USD" },
      new Date(1738900000 * 1000),
      new Date(1738900200 * 1000),
    );
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("missing data.ohlc");
  });

  it("healthCheck: reachable when ticker returns 'last'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(SAMPLE_TICKER_OK)));
    const src = new BitstampSource();
    const health = await src.healthCheck();
    expect(health.reachable).toBe(true);
  });

  it("healthCheck: unreachable when ticker is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({})));
    const src = new BitstampSource();
    const health = await src.healthCheck();
    expect(health.reachable).toBe(false);
  });
});
