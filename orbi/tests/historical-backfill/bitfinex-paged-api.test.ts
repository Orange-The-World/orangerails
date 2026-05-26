/**
 * BitfinexPagedApiSource unit tests — mock the public candles endpoint,
 * verify the [mts, OPEN, CLOSE, HIGH, LOW, VOLUME] tuple order is handled,
 * OHLC invariants hold, pagination advances correctly, and a non-array
 * error response raises.
 */

import { describe, expect, it } from "vitest";
import { BitfinexPagedApiSource, type BitfinexCandleTuple } from "../../scripts/historical-backfill/sources/bitfinex-paged-api";
import { RateLimiter } from "../../scripts/historical-backfill/lib/rate-limiter";

const NOOP_RL = new RateLimiter({ ratePerSec: 1_000_000, burst: 1_000_000 });

function mockFetch(pages: unknown[]): typeof fetch {
  let i = 0;
  return (async (_url: string) => {
    const body = pages[i] ?? [];
    i++;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

async function collect(src: BitfinexPagedApiSource, from: Date, to: Date) {
  const out = [];
  for await (const c of src.fetch("BTC/USD", from, to)) out.push(c);
  return out;
}

describe("BitfinexPagedApiSource.fetch", () => {
  it("maps the [mts, open, close, high, low, volume] tuple correctly", async () => {
    // Tuple order: mts, open, close, high, low, volume
    const page1: BitfinexCandleTuple[] = [
      [1622011200000, 40682.50, 40693.03, 40700.00, 40670.00, 1.123],
      [1622011260000, 40693.03, 40659.07, 40693.03, 40643.91, 3.281],
    ];
    const src = new BitfinexPagedApiSource({ fetchFn: mockFetch([page1, []]), rateLimiter: NOOP_RL });
    const got = await collect(
      src,
      new Date("2021-05-26T06:00:00Z"),
      new Date("2021-05-26T07:00:00Z"),
    );
    expect(got).toHaveLength(2);
    expect(got[0]!.open).toBe(40682.50);
    expect(got[0]!.close).toBe(40693.03);
    expect(got[0]!.high).toBe(40700.00);
    expect(got[0]!.low).toBe(40670.00);
    expect(got[0]!.volume).toBe(1.123);
    for (const c of got) {
      expect(c.high).toBeGreaterThanOrEqual(c.open);
      expect(c.high).toBeGreaterThanOrEqual(c.close);
      expect(c.high).toBeGreaterThanOrEqual(c.low);
      expect(c.low).toBeLessThanOrEqual(c.open);
      expect(c.low).toBeLessThanOrEqual(c.close);
    }
  });

  it("paginates: advances start past last seen ms", async () => {
    const calls: string[] = [];
    const pages: BitfinexCandleTuple[][] = [
      [
        [1622011200000, 100, 105, 110, 90, 1],
        [1622011260000, 105, 110, 115, 100, 2],
      ],
      [
        [1622011320000, 110, 115, 120, 105, 3],
      ],
      [],
    ];
    const fetchFn = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify(pages[calls.length - 1] ?? []), { status: 200 });
    }) as unknown as typeof fetch;
    const src = new BitfinexPagedApiSource({ fetchFn, rateLimiter: NOOP_RL });
    const got = await collect(
      src,
      new Date("2021-05-26T06:00:00Z"),
      new Date("2021-05-26T07:00:00Z"),
    );
    expect(got).toHaveLength(3);
    // Second call should start at last_mts + 60_000 = 1622011260000 + 60_000 = 1622011320000
    expect(calls[1]).toMatch(/start=1622011320000/);
  });

  it("excludes candles whose mts is >= to (exclusive)", async () => {
    const pages: BitfinexCandleTuple[][] = [
      [
        [1622011200000, 100, 105, 110, 90, 1], // 06:40 INCLUDED
        [1622011260000, 105, 110, 115, 100, 2], // 06:41 INCLUDED
        [1622011320000, 110, 115, 120, 105, 3], // 06:42 EXCLUDED (== to)
      ],
    ];
    const src = new BitfinexPagedApiSource({ fetchFn: mockFetch(pages), rateLimiter: NOOP_RL });
    const got = await collect(
      src,
      new Date("2021-05-26T06:40:00Z"),
      new Date("2021-05-26T06:42:00Z"),
    );
    expect(got.map((c) => c.bucketTs.toISOString())).toEqual([
      "2021-05-26T06:40:00.000Z",
      "2021-05-26T06:41:00.000Z",
    ]);
  });

  it("throws when the API returns a non-array body", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: "rate-limited" }), { status: 200 })) as unknown as typeof fetch;
    const src = new BitfinexPagedApiSource({ fetchFn, rateLimiter: NOOP_RL });
    await expect(
      collect(src, new Date("2021-05-26T06:00:00Z"), new Date("2021-05-26T07:00:00Z")),
    ).rejects.toThrow(/non-array response/);
  });

  it("reports the URL shape and supported pairs", () => {
    const src = new BitfinexPagedApiSource();
    expect(src.isSupported("BTC/USD")).toBe(true);
    expect(src.isSupported("BTC/EUR")).toBe(true);
    expect(src.isSupported("BTC/GBP")).toBe(true);
    expect(src.isSupported("BTC/JPY")).toBe(false);
    const url = src.urlFor("BTC/USD", 1622011200000, 1622097600000);
    expect(url).toContain("trade:1m:tBTCUSD");
    expect(url).toContain("sort=1");
    expect(url).toContain("limit=10000");
  });
});
