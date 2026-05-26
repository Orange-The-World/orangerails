/**
 * MercadoBitcoinPagedApiSource unit tests — mock the v4 candles endpoint,
 * verify the TradingView UDF shape parses correctly, symbol is hyphenated,
 * OHLC invariants hold, and `no_data`/empty windows skip forward.
 */

import { describe, expect, it } from "vitest";
import { MercadoBitcoinPagedApiSource } from "../../scripts/historical-backfill/sources/mercado-bitcoin-paged-api";
import { RateLimiter } from "../../scripts/historical-backfill/lib/rate-limiter";

const NOOP_RL = new RateLimiter({ ratePerSec: 1_000_000, burst: 1_000_000 });

function udf(rows: Array<[number, number, number, number, number, number]>) {
  return {
    s: rows.length ? "ok" : "no_data",
    t: rows.map((r) => r[0]),
    o: rows.map((r) => String(r[1])),
    h: rows.map((r) => String(r[2])),
    l: rows.map((r) => String(r[3])),
    c: rows.map((r) => String(r[4])),
    v: rows.map((r) => String(r[5])),
  };
}

function mockFetch(pages: object[]): { fn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(String(url));
    const body = pages[calls.length - 1] ?? udf([]);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

async function collect(src: MercadoBitcoinPagedApiSource, from: Date, to: Date) {
  const out = [];
  for await (const c of src.fetch("BTC/BRL", from, to)) out.push(c);
  return out;
}

describe("MercadoBitcoinPagedApiSource.fetch", () => {
  it("parses UDF arrays into Candles with OHLC invariants", async () => {
    const pages = [
      udf([
        [1747699200, 597856, 598110, 597100, 598000, 1.2],
        [1747699260, 598000, 598200, 597900, 598100, 0.8],
      ]),
      udf([]),
    ];
    const { fn } = mockFetch(pages);
    const src = new MercadoBitcoinPagedApiSource({ fetchFn: fn, rateLimiter: NOOP_RL });
    const got = await collect(
      src,
      new Date("2025-05-20T00:00:00Z"),
      new Date("2025-05-21T00:00:00Z"),
    );
    expect(got).toHaveLength(2);
    expect(got[0]!.open).toBe(597856);
    expect(got[0]!.high).toBe(598110);
    expect(got[0]!.low).toBe(597100);
    expect(got[0]!.close).toBe(598000);
    expect(got[0]!.volume).toBe(1.2);
    expect(got[0]!.bucketTs.toISOString()).toBe(new Date(1747699200 * 1000).toISOString());
  });

  it("uses the hyphenated BASE-QUOTE symbol and unix seconds", async () => {
    const { fn, calls } = mockFetch([udf([])]);
    const src = new MercadoBitcoinPagedApiSource({ fetchFn: fn, rateLimiter: NOOP_RL });
    await collect(src, new Date("2025-05-20T00:00:00Z"), new Date("2025-05-20T01:00:00Z"));
    expect(calls[0]).toContain("symbol=BTC-BRL");
    expect(calls[0]).toContain("resolution=1m");
    expect(calls[0]).toContain("from=1747699200");
    expect(calls[0]).toContain("to=1747702800");
  });

  it("advances past empty windows (no_data) without infinite loop", async () => {
    const pages = [
      udf([]), // chunk 1 empty
      udf([]), // chunk 2 empty
      udf([[1747872000, 100, 110, 90, 105, 1]]), // chunk 3 has one row
      udf([]),
    ];
    const { fn, calls } = mockFetch(pages);
    const src = new MercadoBitcoinPagedApiSource({ fetchFn: fn, rateLimiter: NOOP_RL });
    const got = await collect(
      src,
      new Date("2025-05-20T00:00:00Z"),
      new Date("2025-05-23T00:00:00Z"), // 3 days → 3 chunks
    );
    expect(got).toHaveLength(1);
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it("excludes candles whose t is >= to (exclusive)", async () => {
    const pages = [
      udf([
        [1747699200, 100, 110, 90, 105, 1],
        [1747699260, 105, 115, 100, 110, 2],
        [1747699320, 110, 120, 105, 115, 3], // exactly at upper bound
      ]),
      udf([]),
    ];
    const { fn } = mockFetch(pages);
    const src = new MercadoBitcoinPagedApiSource({ fetchFn: fn, rateLimiter: NOOP_RL });
    const got = await collect(
      src,
      new Date("2025-05-20T00:00:00Z"),
      new Date(1747699320 * 1000),
    );
    expect(got.map((c) => c.bucketTs.toISOString())).toEqual([
      new Date(1747699200 * 1000).toISOString(),
      new Date(1747699260 * 1000).toISOString(),
    ]);
  });

  it("throws on API error code (e.g. SYMBOL_IS_INVALID)", async () => {
    const fn = (async () =>
      new Response(
        JSON.stringify({ code: "PUBLIC_DATA|LIST_CANDLES|SYMBOL_IS_INVALID", message: "bad symbol" }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const src = new MercadoBitcoinPagedApiSource({ fetchFn: fn, rateLimiter: NOOP_RL });
    await expect(
      collect(src, new Date("2025-05-20T00:00:00Z"), new Date("2025-05-20T01:00:00Z")),
    ).rejects.toThrow(/SYMBOL_IS_INVALID|API error/);
  });
});
