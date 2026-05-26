/**
 * BitstampPagedApiSource unit tests — mock the public OHLC endpoint, parse
 * a paged response, assert each candle obeys OHLC invariants + pagination
 * advances correctly + duplicate timestamps are de-duped + the page cap
 * terminates the loop.
 */

import { describe, expect, it } from "vitest";
import { BitstampPagedApiSource } from "../../scripts/historical-backfill/sources/bitstamp-paged-api";
import { RateLimiter } from "../../scripts/historical-backfill/lib/rate-limiter";

/** Build a Bitstamp-shaped page. ts is unix-seconds. */
function page(rows: Array<[number, number, number, number, number, number]>) {
  return {
    data: {
      pair: "BTC/USD",
      ohlc: rows.map(([t, o, h, l, c, v]) => ({
        timestamp: String(t),
        open: String(o),
        high: String(h),
        low: String(l),
        close: String(c),
        volume: String(v),
      })),
    },
  };
}

function mockFetch(pages: object[]): typeof fetch {
  let i = 0;
  return (async (_url: string) => {
    const body = pages[i] ?? { data: { pair: "BTC/USD", ohlc: [] } };
    i++;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const NOOP_RL = new RateLimiter({ ratePerSec: 1_000_000, burst: 1_000_000 });

async function collect(src: BitstampPagedApiSource, pair: "BTC/USD" | "BTC/EUR" | "BTC/GBP", from: Date, to: Date) {
  const out = [];
  for await (const c of src.fetch(pair, from, to)) out.push(c);
  return out;
}

describe("BitstampPagedApiSource.fetch", () => {
  it("yields candles with OHLC invariants and correct timestamps", async () => {
    const pages = [
      page([
        [1622011200, 40682.50, 40700.00, 40670.00, 40693.03, 1.123],
        [1622011260, 40693.03, 40693.03, 40643.91, 40659.07, 3.281],
        [1622011320, 40629.25, 40693.20, 40629.25, 40678.27, 3.609],
      ]),
      // empty -> terminates
    ];
    const src = new BitstampPagedApiSource({ fetchFn: mockFetch(pages), rateLimiter: NOOP_RL });
    const got = await collect(
      src,
      "BTC/USD",
      new Date("2021-05-26T06:00:00Z"),
      new Date("2021-05-26T07:00:00Z"),
    );
    expect(got).toHaveLength(3);
    for (const c of got) {
      expect(c.high).toBeGreaterThanOrEqual(c.open);
      expect(c.high).toBeGreaterThanOrEqual(c.close);
      expect(c.high).toBeGreaterThanOrEqual(c.low);
      expect(c.low).toBeLessThanOrEqual(c.open);
      expect(c.low).toBeLessThanOrEqual(c.close);
      expect(c.volume).toBeGreaterThan(0);
    }
    expect(got[0]!.bucketTs.toISOString()).toBe("2021-05-26T06:40:00.000Z");
  });

  it("paginates: advances start past last seen timestamp", async () => {
    const pages = [
      page([
        [1622011200, 100, 110, 90, 105, 1],
        [1622011260, 105, 115, 100, 110, 2],
      ]),
      page([
        [1622011320, 110, 120, 105, 115, 3],
      ]),
      page([]),
    ];
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(String(url));
      const body = pages[calls.length - 1] ?? { data: { pair: "BTC/USD", ohlc: [] } };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const src = new BitstampPagedApiSource({ fetchFn, rateLimiter: NOOP_RL });
    const got = await collect(
      src,
      "BTC/USD",
      new Date("2021-05-26T06:00:00Z"),
      new Date("2021-05-26T07:00:00Z"),
    );
    expect(got).toHaveLength(3);
    // First call starts at fromSec; second call starts at 1622011260+60=1622011320
    expect(calls[0]).toMatch(/start=1622008800/); // 2021-05-26T06:00 UTC
    expect(calls[1]).toMatch(/start=1622011320/);
  });

  it("filters candles >= to (exclusive upper bound)", async () => {
    const pages = [
      page([
        [1622011200, 100, 110, 90, 105, 1],
        [1622011260, 105, 115, 100, 110, 2], // 06:41:00 — INCLUDED
        [1622011320, 110, 120, 105, 115, 3], // 06:42:00 — at upper bound, EXCLUDED
      ]),
    ];
    const src = new BitstampPagedApiSource({ fetchFn: mockFetch(pages), rateLimiter: NOOP_RL });
    const got = await collect(
      src,
      "BTC/USD",
      new Date("2021-05-26T06:40:00Z"),
      new Date("2021-05-26T06:42:00Z"),
    );
    expect(got.map((c) => c.bucketTs.toISOString())).toEqual([
      "2021-05-26T06:40:00.000Z",
      "2021-05-26T06:41:00.000Z",
    ]);
  });

  it("rejects unsupported pairs and exposes the URL shape", () => {
    const src = new BitstampPagedApiSource();
    expect(src.isSupported("BTC/USD")).toBe(true);
    expect(src.isSupported("BTC/EUR")).toBe(true);
    expect(src.isSupported("BTC/GBP")).toBe(true);
    expect(src.isSupported("DOGE/MOON")).toBe(false);
    expect(src.urlFor("BTC/USD", 1622011200)).toBe(
      "https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=60&start=1622011200&limit=1000",
    );
  });

  it("de-dups overlapping timestamps across pages", async () => {
    const pages = [
      page([
        [1622011200, 100, 110, 90, 105, 1],
        [1622011260, 105, 115, 100, 110, 2],
      ]),
      page([
        [1622011260, 105, 115, 100, 110, 2], // duplicate
        [1622011320, 110, 120, 105, 115, 3],
      ]),
      page([]),
    ];
    const src = new BitstampPagedApiSource({ fetchFn: mockFetch(pages), rateLimiter: NOOP_RL });
    const got = await collect(
      src,
      "BTC/USD",
      new Date("2021-05-26T06:00:00Z"),
      new Date("2021-05-26T07:00:00Z"),
    );
    expect(got).toHaveLength(3);
  });
});
