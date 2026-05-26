import { describe, expect, it, vi, beforeEach } from "vitest";
import { FrankfurterSource } from "../src/sources/frankfurter";

const SAMPLE_RESPONSE = {
  amount: 1,
  base: "USD",
  date: "2026-05-26",
  rates: { MXN: 17.32, EUR: 0.93, BRL: 5.06 },
};

function mockFetchResponse(jsonBody: unknown, status = 200): Response {
  return new Response(JSON.stringify(jsonBody), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("FrankfurterSource", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("config: cross-rate role (not voting in BTC median)", () => {
    const src = new FrankfurterSource();
    expect(src.name).toBe("frankfurter");
    expect(src.role).toBe("cross-rate"); // <-- NOT 'primary' — won't be voted in BTC VW-median
    expect(src.rateLimitRps).toBe(1.0);
    expect(src.pairsSupported).toContain("USD-MXN");
    expect(src.pairsSupported).toContain("USD-INR");
  });

  it("fetch USD-MXN: returns single synthetic candle", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(SAMPLE_RESPONSE)));
    const src = new FrankfurterSource();
    const result = await src.fetch(
      { source: "USD", target: "MXN" },
      new Date("2026-05-25T00:00:00Z"),
      new Date("2026-05-26T03:00:00Z"),
    );
    expect(result.success).toBe(true);
    expect(result.candles).toHaveLength(1);
    expect(result.candles[0]!.close).toBe(17.32);
    expect(result.candles[0]!.volume).toBe(1.0);
  });

  it("fetch USD-BRL: returns BRL rate", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(SAMPLE_RESPONSE)));
    const src = new FrankfurterSource();
    const result = await src.fetch(
      { source: "USD", target: "BRL" },
      new Date("2026-05-25T00:00:00Z"),
      new Date("2026-05-26T03:00:00Z"),
    );
    expect(result.success).toBe(true);
    expect(result.candles[0]!.close).toBe(5.06);
  });

  it("fetch: unsupported pair → success=false", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const src = new FrankfurterSource();
    const result = await src.fetch({ source: "USD", target: "ZZZ" }, new Date(), new Date());
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("unsupported pair");
  });

  it("fetch: missing target in response → success=false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ rates: {} })));
    const src = new FrankfurterSource();
    const result = await src.fetch(
      { source: "USD", target: "MXN" },
      new Date("2026-05-25T00:00:00Z"),
      new Date("2026-05-26T03:00:00Z"),
    );
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("no rate for MXN");
  });

  it("healthCheck: reachable when /latest USD-EUR returns a rate", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(SAMPLE_RESPONSE)));
    const src = new FrankfurterSource();
    const health = await src.healthCheck();
    expect(health.reachable).toBe(true);
  });
});
