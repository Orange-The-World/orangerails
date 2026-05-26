import { describe, expect, it, vi, beforeEach } from "vitest";
import { UpbitSource } from "../src/sources/upbit";

const SAMPLE_CANDLES = [
  {
    market: "KRW-BTC",
    candle_date_time_utc: "2026-05-26T22:35:00",
    candle_date_time_kst: "2026-05-27T07:35:00",
    opening_price: 112601000, high_price: 112650000, low_price: 112500000, trade_price: 112620000,
    timestamp: 1779834912320, candle_acc_trade_price: 5_349_735.0, candle_acc_trade_volume: 0.475, unit: 1,
  },
  {
    market: "KRW-BTC",
    candle_date_time_utc: "2026-05-26T22:34:00",
    candle_date_time_kst: "2026-05-27T07:34:00",
    opening_price: 112578000, high_price: 112601000, low_price: 112576000, trade_price: 112601000,
    timestamp: 1779834899222, candle_acc_trade_price: 26_131_420.0, candle_acc_trade_volume: 2.321, unit: 1,
  },
];
const SAMPLE_TICKER = [{ trade_price: 112600000 }];

function mockJson(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}

describe("UpbitSource", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("config: maps BTC-KRW to KRW-BTC market", () => {
    const s = new UpbitSource();
    expect(s.name).toBe("upbit");
    expect(s.pairsSupported).toEqual(["BTC-KRW"]);
  });

  it("fetch: parses minute candles and sorts ascending", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_CANDLES)));
    const s = new UpbitSource();
    const r = await s.fetch({ source: "BTC", target: "KRW" },
      new Date("2026-05-26T22:34:00Z"), new Date("2026-05-26T22:36:00Z"));
    expect(r.success).toBe(true);
    expect(r.candles).toHaveLength(2);
    expect(r.candles[0]!.bucketTs.toISOString()).toBe("2026-05-26T22:34:00.000Z");
    expect(r.candles[0]!.close).toBe(112601000);
    expect(r.candles[1]!.volume).toBeCloseTo(0.475);
  });

  it("fetch: non-array response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson({ err: "x" })));
    const s = new UpbitSource();
    const r = await s.fetch({ source: "BTC", target: "KRW" }, new Date(), new Date());
    expect(r.success).toBe(false);
  });

  it("fetch: unsupported pair", async () => {
    const s = new UpbitSource();
    const r = await s.fetch({ source: "BTC", target: "USD" }, new Date(), new Date());
    expect(r.success).toBe(false);
  });

  it("healthCheck: reachable on trade_price>0", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_TICKER)));
    const s = new UpbitSource();
    const h = await s.healthCheck();
    expect(h.reachable).toBe(true);
  });
});
