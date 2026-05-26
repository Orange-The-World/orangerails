/**
 * BitstampCsvSource unit tests — parse a small CSV fixture and assert each
 * row maps to a valid Candle (OHLC invariants, positive volume, ISO bucketTs).
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BitstampCsvSource } from "../../scripts/historical-backfill/sources/bitstamp-csv";

const FIXTURE = `https://www.CryptoDataDownload.com
unix,date,symbol,open,high,low,close,Volume BTC,Volume USD
1622011380,2021-05-26 06:43:00,BTC/USD,40691.34,40691.34,40675.41,40675.41,0.44432861,18073.248386480103
1622011320,2021-05-26 06:42:00,BTC/USD,40629.25,40693.20,40629.25,40678.27,3.60999993,146848.55185252108
1622011260,2021-05-26 06:41:00,BTC/USD,40693.03,40693.03,40643.91,40659.07,3.28107729,133405.5512095203
1622011200,2021-05-26 06:40:00,BTC/USD,40682.50,40700.00,40670.00,40693.03,1.12345678,45710.123
1622011140,2021-05-26 06:39:00,BTC/USD,40670.00,40690.00,40660.00,40682.50,0.50000000,20336.25
`;

function writeFixture(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "orbi-csv-test-"));
  const path = join(dir, "fixture.csv");
  writeFileSync(path, FIXTURE);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function collectAll(src: BitstampCsvSource, path: string, from: Date, to: Date) {
  const out = [];
  for await (const c of src.parse(path, from, to)) out.push(c);
  return out;
}

describe("BitstampCsvSource.parse", () => {
  it("yields every row inside the window as a valid Candle", async () => {
    const { path, cleanup } = writeFixture();
    try {
      const src = new BitstampCsvSource();
      const candles = await collectAll(
        src,
        path,
        new Date("2021-05-26T06:00:00Z"),
        new Date("2021-05-26T07:00:00Z"),
      );
      expect(candles).toHaveLength(5);
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
      const src = new BitstampCsvSource();
      const candles = await collectAll(
        src,
        path,
        new Date("2021-05-26T06:41:00Z"),
        new Date("2021-05-26T06:43:00Z"),
      );
      // Expect 06:41 and 06:42 only (06:43 is the upper bound, exclusive)
      expect(candles.map((c) => c.bucketTs.toISOString())).toEqual([
        "2021-05-26T06:42:00.000Z",
        "2021-05-26T06:41:00.000Z",
      ]);
    } finally {
      cleanup();
    }
  });

  it("isSupported reports BTC/USD and BTC/EUR but rejects unknown pairs", () => {
    const src = new BitstampCsvSource();
    expect(src.isSupported("BTC/USD")).toBe(true);
    expect(src.isSupported("BTC/EUR")).toBe(true);
    expect(src.isSupported("BTC/GBP")).toBe(false);
    expect(src.isSupported("DOGE/MOON")).toBe(false);
  });

  it("urlFor points at the cryptodatadownload.com mirror", () => {
    const src = new BitstampCsvSource();
    expect(src.urlFor("BTC/USD")).toBe(
      "https://www.cryptodatadownload.com/cdd/Bitstamp_BTCUSD_minute.csv",
    );
  });

  it("preserves price + volume values byte-for-byte from CSV", async () => {
    const { path, cleanup } = writeFixture();
    try {
      const src = new BitstampCsvSource();
      const candles = await collectAll(
        src,
        path,
        new Date("2021-05-26T06:43:00Z"),
        new Date("2021-05-26T06:44:00Z"),
      );
      expect(candles).toHaveLength(1);
      expect(candles[0]!.close).toBe(40675.41);
      expect(candles[0]!.volume).toBeCloseTo(0.44432861, 8);
    } finally {
      cleanup();
    }
  });
});
