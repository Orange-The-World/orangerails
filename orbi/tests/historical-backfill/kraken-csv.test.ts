/**
 * KrakenCsvSource unit tests — parse a small fixture CSV (header-less, the
 * Kraken bulk-OHLCVT format) and assert each row maps to a valid Candle
 * (OHLC invariants, positive volume, ISO bucketTs). Also asserts the
 * pair→XBT mapping and quarter-range enumeration.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KrakenCsvSource } from "../../scripts/historical-backfill/sources/kraken-csv";

// Header-less Kraken format: unix,open,high,low,close,volume,trades
// Ten consecutive minutes around 2024-01-15 12:00 UTC.
const FIXTURE = `1705320000,42500.10,42510.50,42495.00,42505.20,1.50000000,42
1705320060,42505.20,42520.00,42500.00,42515.75,2.10000000,55
1705320120,42515.75,42525.00,42510.00,42520.50,0.75000000,30
1705320180,42520.50,42530.00,42515.00,42528.10,3.20000000,78
1705320240,42528.10,42540.00,42525.00,42535.80,1.10000000,40
1705320300,42535.80,42545.00,42530.00,42540.25,0.90000000,28
1705320360,42540.25,42550.00,42535.00,42547.60,2.50000000,62
1705320420,42547.60,42555.00,42540.00,42550.10,1.80000000,48
1705320480,42550.10,42560.00,42545.00,42555.40,1.25000000,38
1705320540,42555.40,42565.00,42550.00,42560.90,1.65000000,52
`;

function writeFixture(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "orbi-kraken-test-"));
  const path = join(dir, "XBTUSD_1.csv");
  writeFileSync(path, FIXTURE);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function collectAll(src: KrakenCsvSource, path: string, from: Date, to: Date) {
  const out = [];
  for await (const c of src.parse(path, from, to)) out.push(c);
  return out;
}

describe("KrakenCsvSource.parse", () => {
  it("yields every row inside the window as a valid Candle", async () => {
    const { path, cleanup } = writeFixture();
    try {
      const src = new KrakenCsvSource();
      const candles = await collectAll(
        src,
        path,
        new Date("2024-01-15T11:00:00Z"),
        new Date("2024-01-15T13:00:00Z"),
      );
      expect(candles).toHaveLength(10);
      for (const c of candles) {
        expect(c.bucketTs).toBeInstanceOf(Date);
        expect(c.high).toBeGreaterThanOrEqual(c.open);
        expect(c.high).toBeGreaterThanOrEqual(c.close);
        expect(c.high).toBeGreaterThanOrEqual(c.low);
        expect(c.low).toBeLessThanOrEqual(c.open);
        expect(c.low).toBeLessThanOrEqual(c.close);
        expect(c.volume).toBeGreaterThan(0);
        expect(c.close).toBeGreaterThan(0);
      }
    } finally {
      cleanup();
    }
  });

  it("filters rows outside [from, to)", async () => {
    const { path, cleanup } = writeFixture();
    try {
      const src = new KrakenCsvSource();
      const candles = await collectAll(
        src,
        path,
        new Date("2024-01-15T12:02:00Z"),
        new Date("2024-01-15T12:05:00Z"),
      );
      // Expect 12:02, 12:03, 12:04 only (12:05 upper bound, exclusive)
      expect(candles.map((c) => c.bucketTs.toISOString())).toEqual([
        "2024-01-15T12:02:00.000Z",
        "2024-01-15T12:03:00.000Z",
        "2024-01-15T12:04:00.000Z",
      ]);
    } finally {
      cleanup();
    }
  });

  it("preserves price + volume values from CSV", async () => {
    const { path, cleanup } = writeFixture();
    try {
      const src = new KrakenCsvSource();
      const candles = await collectAll(
        src,
        path,
        new Date("2024-01-15T12:00:00Z"),
        new Date("2024-01-15T12:01:00Z"),
      );
      expect(candles).toHaveLength(1);
      expect(candles[0]!.open).toBe(42500.1);
      expect(candles[0]!.high).toBe(42510.5);
      expect(candles[0]!.low).toBe(42495.0);
      expect(candles[0]!.close).toBe(42505.2);
      expect(candles[0]!.volume).toBeCloseTo(1.5, 8);
    } finally {
      cleanup();
    }
  });
});

describe("KrakenCsvSource.isSupported + symbol mapping", () => {
  const src = new KrakenCsvSource();

  it("reports all 7 BTC pairs as supported", () => {
    expect(src.isSupported("BTC/USD")).toBe(true);
    expect(src.isSupported("BTC/EUR")).toBe(true);
    expect(src.isSupported("BTC/GBP")).toBe(true);
    expect(src.isSupported("BTC/CAD")).toBe(true);
    expect(src.isSupported("BTC/AUD")).toBe(true);
    expect(src.isSupported("BTC/JPY")).toBe(true);
    expect(src.isSupported("BTC/CHF")).toBe(true);
  });

  it("rejects unknown pairs", () => {
    expect(src.isSupported("BTC/BRL")).toBe(false);
    expect(src.isSupported("DOGE/MOON")).toBe(false);
    expect(src.isSupported("ETH/USD")).toBe(false);
  });

  it("maps BTC/X → XBTX (Kraken's symbol convention)", () => {
    expect(src.krakenSymbol("BTC/USD")).toBe("XBTUSD");
    expect(src.krakenSymbol("BTC/EUR")).toBe("XBTEUR");
    expect(src.krakenSymbol("BTC/GBP")).toBe("XBTGBP");
    expect(src.krakenSymbol("BTC/CAD")).toBe("XBTCAD");
    expect(src.krakenSymbol("BTC/AUD")).toBe("XBTAUD");
    expect(src.krakenSymbol("BTC/JPY")).toBe("XBTJPY");
    expect(src.krakenSymbol("BTC/CHF")).toBe("XBTCHF");
  });
});

describe("KrakenCsvSource.quartersInRange", () => {
  const src = new KrakenCsvSource();

  it("returns a single quarter for a window inside one quarter", () => {
    const q = src.quartersInRange(new Date("2024-02-15"), new Date("2024-03-01"));
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ year: 2024, quarter: 1, zipName: "Kraken_OHLCVT_Q1_2024.zip" });
  });

  it("returns every quarter crossed by a multi-quarter window", () => {
    const q = src.quartersInRange(new Date("2024-02-15"), new Date("2024-09-15"));
    expect(q.map((x) => x.zipName)).toEqual([
      "Kraken_OHLCVT_Q1_2024.zip",
      "Kraken_OHLCVT_Q2_2024.zip",
      "Kraken_OHLCVT_Q3_2024.zip",
    ]);
  });

  it("crosses year boundaries", () => {
    const q = src.quartersInRange(new Date("2023-11-01"), new Date("2024-04-01"));
    expect(q.map((x) => x.zipName)).toEqual([
      "Kraken_OHLCVT_Q4_2023.zip",
      "Kraken_OHLCVT_Q1_2024.zip",
      // Q2_2024 starts at 2024-04-01 which is the exclusive upper bound — excluded.
    ]);
  });

  it("respects half-open upper bound (to exactly on quarter start)", () => {
    const q = src.quartersInRange(new Date("2024-01-01"), new Date("2024-04-01"));
    expect(q.map((x) => x.zipName)).toEqual(["Kraken_OHLCVT_Q1_2024.zip"]);
  });

  it("returns empty when from >= to", () => {
    expect(src.quartersInRange(new Date("2024-04-01"), new Date("2024-03-01"))).toEqual([]);
    expect(src.quartersInRange(new Date("2024-03-01"), new Date("2024-03-01"))).toEqual([]);
  });
});

describe("KrakenCsvSource.urlForQuarter", () => {
  const src = new KrakenCsvSource();

  it("builds the drive.usercontent.google.com URL for a mapped quarter", () => {
    const url = src.urlForQuarter("Kraken_OHLCVT_Q1_2024.zip");
    expect(url).toContain("drive.usercontent.google.com/download");
    expect(url).toContain("confirm=t");
    expect(url).toContain("id=1JkH3c13madqdpF-dzXoseX_sYY1E2iHx");
  });

  it("throws on an unmapped quarter", () => {
    expect(() => src.urlForQuarter("Kraken_OHLCVT_Q3_2099.zip")).toThrow(/no Drive ID/);
  });
});
