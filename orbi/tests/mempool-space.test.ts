import { describe, expect, it, vi, beforeEach } from "vitest";
import { MempoolSpaceSource } from "../src/sources/mempool-space";

const SAMPLE_PRICES = {
  time: 1738900200,
  USD: 97250,
  EUR: 90120,
  GBP: 77450,
  CAD: 132890,
  CHF: 85234,
  AUD: 148120,
  JPY: 14525000,
};

function mockFetchResponse(jsonBody: unknown, status = 200): Response {
  return new Response(JSON.stringify(jsonBody), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("MempoolSpaceSource — unit tests", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("config: mempool.space, primary, 1 rps, BTC + 7 fiat", () => {
    const src = new MempoolSpaceSource();
    expect(src.name).toBe("mempool.space");
    expect(src.role).toBe("primary");
    expect(src.rateLimitRps).toBe(1.0);
    expect(src.pairsSupported.length).toBe(7);
    expect(src.pairsSupported).toContain("BTC-USD");
    expect(src.pairsSupported).toContain("BTC-CAD");
  });

  it("fetch: returns one synthetic candle with snapshot price + normalized volume", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(SAMPLE_PRICES)));
    const src = new MempoolSpaceSource();
    const result = await src.fetch(
      { source: "BTC", target: "USD" },
      new Date(1738900000000),
      new Date(1738900200000),
    );
    expect(result.success).toBe(true);
    expect(result.candles).toHaveLength(1);
    expect(result.candles[0]!.close).toBe(97250);
    expect(result.candles[0]!.open).toBe(97250);
    expect(result.candles[0]!.volume).toBe(1.0); // normalized constant
  });

  it("fetch: returns EUR price when target=EUR", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(SAMPLE_PRICES)));
    const src = new MempoolSpaceSource();
    const result = await src.fetch(
      { source: "BTC", target: "EUR" },
      new Date(1738900000000),
      new Date(1738900200000),
    );
    expect(result.success).toBe(true);
    expect(result.candles[0]!.close).toBe(90120);
  });

  it("fetch: unsupported target → success=false", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const src = new MempoolSpaceSource();
    const result = await src.fetch({ source: "BTC", target: "MXN" }, new Date(), new Date());
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("unsupported target");
  });

  it("fetch: source must be BTC", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const src = new MempoolSpaceSource();
    const result = await src.fetch({ source: "ETH", target: "USD" }, new Date(), new Date());
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("only BTC source supported");
  });

  it("fetch: missing price in response → success=false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ time: 1738900200 })));
    const src = new MempoolSpaceSource();
    const result = await src.fetch(
      { source: "BTC", target: "USD" },
      new Date(1738900000000),
      new Date(1738900200000),
    );
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("no valid price for USD");
  });

  it("healthCheck: reachable when USD price present", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(SAMPLE_PRICES)));
    const src = new MempoolSpaceSource();
    const health = await src.healthCheck();
    expect(health.reachable).toBe(true);
  });
});
