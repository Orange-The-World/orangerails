import { describe, expect, it, vi, beforeEach } from "vitest";
import { BtcTurkSource } from "../src/sources/btcturk";

// TradingView UDF columnar shape from /v1/klines/history
const SAMPLE_KLINES = {
  s: "ok",
  t: [1779835200, 1779835260, 1779835320],
  o: [3481626, 3480928, 3481959],
  h: [3482280, 3480928, 3481959],
  l: [3481626, 3480928, 3481959],
  c: [3482280, 3480928, 3481959],
  v: [0.5, 0.7, 0.3],
};
const SAMPLE_TICKER = { success: true, data: [{ last: 3500000 }] };

function mockJson(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}

describe("BtcTurkSource", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("config", () => {
    const s = new BtcTurkSource();
    expect(s.name).toBe("btcturk");
    expect(s.pairsSupported).toEqual(["BTC-TRY"]);
    expect(s.endpointBase).toBe("https://graph-api.btcturk.com");
  });

  it("fetch: parses TradingView UDF columnar klines", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_KLINES)));
    const s = new BtcTurkSource();
    const r = await s.fetch({ source: "BTC", target: "TRY" },
      new Date(1779835200000), new Date(1779835320000));
    expect(r.success).toBe(true);
    expect(r.candles).toHaveLength(3);
    expect(r.candles[0]!.close).toBe(3482280);
    expect(r.candles[1]!.volume).toBeCloseTo(0.7);
  });

  it("fetch: s != 'ok' returns success=false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson({ s: "no_data" })));
    const s = new BtcTurkSource();
    const r = await s.fetch({ source: "BTC", target: "TRY" }, new Date(), new Date());
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain("status=no_data");
  });

  it("fetch: unsupported pair", async () => {
    const s = new BtcTurkSource();
    const r = await s.fetch({ source: "BTC", target: "USD" }, new Date(), new Date());
    expect(r.success).toBe(false);
  });

  it("fetch: missing volume column defaults to 0", async () => {
    const noVol = { ...SAMPLE_KLINES, v: undefined };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(noVol)));
    const s = new BtcTurkSource();
    const r = await s.fetch({ source: "BTC", target: "TRY" },
      new Date(1779835200000), new Date(1779835320000));
    expect(r.success).toBe(true);
    expect(r.candles[0]!.volume).toBe(0);
  });

  it("healthCheck: reachable on success ticker", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJson(SAMPLE_TICKER)));
    const s = new BtcTurkSource();
    const h = await s.healthCheck();
    expect(h.reachable).toBe(true);
  });
});
