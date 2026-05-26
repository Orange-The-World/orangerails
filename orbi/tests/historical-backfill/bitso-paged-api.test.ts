/**
 * BitsoPagedApiSource unit tests — mock the /v3/ohlc endpoint, verify the
 * ms-based start/end is honored, the bucket map (first_rate→open,
 * last_rate→close, max_rate→high, min_rate→low) lands correctly, and
 * zero-volume "carry the last quote" buckets are still emitted (volume=0).
 */

import { describe, expect, it } from "vitest";
import { BitsoPagedApiSource } from "../../scripts/historical-backfill/sources/bitso-paged-api";
import { RateLimiter } from "../../scripts/historical-backfill/lib/rate-limiter";

const NOOP_RL = new RateLimiter({ ratePerSec: 1_000_000, burst: 1_000_000 });

function bucket(ms: number, first: number, last: number, min: number, max: number, vol: number, trades = 1) {
  return {
    bucket_start_time: ms,
    first_trade_time: ms + 1000,
    last_trade_time: ms + 59000,
    first_rate: String(first),
    last_rate: String(last),
    min_rate: String(min),
    max_rate: String(max),
    trade_count: trades,
    volume: String(vol),
    vwap: String((first + last) / 2),
  };
}

function mockFetch(pages: object[]): { fn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(String(url));
    const body = pages[calls.length - 1] ?? { success: true, payload: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

async function collect(src: BitsoPagedApiSource, pair: "BTC/MXN" | "BTC/BRL" | "BTC/ARS" | "BTC/USD", from: Date, to: Date) {
  const out = [];
  for await (const c of src.fetch(pair, from, to)) out.push(c);
  return out;
}

describe("BitsoPagedApiSource.fetch", () => {
  it("maps first_rate→open, last_rate→close, max→high, min→low", async () => {
    const pages = [
      {
        success: true,
        payload: [
          bucket(1747699200000, 1000, 1020, 990, 1030, 0.5),
          bucket(1747699260000, 1020, 1010, 1005, 1025, 0.3),
        ],
      },
      { success: true, payload: [] },
    ];
    const { fn } = mockFetch(pages);
    const src = new BitsoPagedApiSource({ fetchFn: fn, rateLimiter: NOOP_RL });
    const got = await collect(
      src,
      "BTC/MXN",
      new Date("2025-05-20T00:00:00Z"),
      new Date("2025-05-21T00:00:00Z"),
    );
    expect(got).toHaveLength(2);
    expect(got[0]!.open).toBe(1000);
    expect(got[0]!.close).toBe(1020);
    expect(got[0]!.high).toBe(1030);
    expect(got[0]!.low).toBe(990);
    expect(got[0]!.volume).toBe(0.5);
  });

  it("uses milliseconds in the start/end query params", async () => {
    const { fn, calls } = mockFetch([{ success: true, payload: [] }]);
    const src = new BitsoPagedApiSource({ fetchFn: fn, rateLimiter: NOOP_RL });
    // tiny window so only one page is needed
    await collect(src, "BTC/MXN", new Date("2025-05-20T00:00:00Z"), new Date("2025-05-20T01:00:00Z"));
    expect(calls[0]).toContain("start=1747699200000");
    expect(calls[0]).toContain("end=1747702800000");
    expect(calls[0]).toContain("time_bucket=60");
    expect(calls[0]).toContain("book=btc_mxn");
  });

  it("emits zero-volume carry-the-quote buckets with volume=0", async () => {
    const pages = [
      {
        success: true,
        payload: [
          // trade_count=0, volume="0", rates all equal (Bitso carry-the-last)
          bucket(1747699200000, 2042350, 2042350, 2042350, 2042350, 0, 0),
        ],
      },
      { success: true, payload: [] },
    ];
    const { fn } = mockFetch(pages);
    const src = new BitsoPagedApiSource({ fetchFn: fn, rateLimiter: NOOP_RL });
    const got = await collect(
      src,
      "BTC/MXN",
      new Date("2025-05-20T00:00:00Z"),
      new Date("2025-05-20T00:30:00Z"),
    );
    expect(got).toHaveLength(1);
    expect(got[0]!.volume).toBe(0);
    expect(got[0]!.close).toBe(2042350);
  });

  it("filters bucket_start_time >= to (exclusive)", async () => {
    const pages = [
      {
        success: true,
        payload: [
          bucket(1747699200000, 100, 105, 95, 110, 1),
          bucket(1747699260000, 105, 110, 100, 115, 1),
          // exactly at the upper bound — EXCLUDED
          bucket(1747699320000, 110, 115, 105, 120, 1),
        ],
      },
    ];
    const { fn } = mockFetch(pages);
    const src = new BitsoPagedApiSource({ fetchFn: fn, rateLimiter: NOOP_RL });
    const got = await collect(
      src,
      "BTC/MXN",
      new Date("2025-05-20T00:00:00Z"),
      new Date(1747699320000),
    );
    expect(got).toHaveLength(2);
    expect(got[1]!.bucketTs.toISOString()).toBe(new Date(1747699260000).toISOString());
  });

  it("throws on success=false API error", async () => {
    const fn = (async () =>
      new Response(
        JSON.stringify({ success: false, error: { code: "0301", message: "Invalid book" } }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const src = new BitsoPagedApiSource({ fetchFn: fn, rateLimiter: NOOP_RL });
    await expect(
      collect(src, "BTC/MXN", new Date("2025-05-20T00:00:00Z"), new Date("2025-05-20T01:00:00Z")),
    ).rejects.toThrow(/API error/);
  });

  it("reports supported pairs and URL shape", () => {
    const src = new BitsoPagedApiSource();
    expect(src.isSupported("BTC/MXN")).toBe(true);
    expect(src.isSupported("BTC/ARS")).toBe(true);
    expect(src.isSupported("BTC/BRL")).toBe(true);
    expect(src.isSupported("BTC/USD")).toBe(true);
    expect(src.isSupported("BTC/USDT")).toBe(false);
    expect(src.urlFor("BTC/MXN", 1, 2)).toBe(
      "https://api.bitso.com/v3/ohlc?book=btc_mxn&time_bucket=60&start=1&end=2",
    );
  });
});
