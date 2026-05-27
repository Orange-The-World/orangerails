import { describe, expect, it } from "vitest";
import { SnbSource, matchSnbPair, normaliseDate } from "../../scripts/central-banks/sources/snb";

const CSV = `Date,D0,D1,Value
2024-03-01,USD1,SPOT,0.8852
2024-03-01,EUR1,SPOT,0.9587
2024-03-01,GBP1,SPOT,1.1182
2024-03-01,JPY100,SPOT,0.5901
2024-03-04,USD1,SPOT,0.8810
`;

describe("SnbSource", () => {
  it("matchSnbPair maps tags to pair labels", () => {
    expect(matchSnbPair("USD1")).toEqual({ pair: "USD/CHF", per100: false });
    expect(matchSnbPair("EUR1")).toEqual({ pair: "EUR/CHF", per100: false });
    expect(matchSnbPair("JPY100")).toEqual({ pair: "JPY/CHF", per100: true });
    expect(matchSnbPair("XYZ")).toBeNull();
  });

  it("normaliseDate handles ISO and DD.MM.YYYY", () => {
    expect(normaliseDate("2024-03-01")).toBe("2024-03-01");
    expect(normaliseDate("01.03.2024")).toBe("2024-03-01");
    expect(normaliseDate("garbage")).toBeNull();
  });

  it("parseCsv extracts one row per (date, currency)", () => {
    const src = new SnbSource();
    const rows = src.parseCsv(CSV);
    // 4 pairs on 2024-03-01 + 1 row on 2024-03-04 = 5.
    expect(rows).toHaveLength(5);
    const jpyRow = rows.find((r) => r.pair === "JPY/CHF" && r.date === "2024-03-01");
    expect(jpyRow).toBeDefined();
    // SNB published 0.5901 CHF per 100 JPY → normalise to 0.005901 CHF per 1 JPY.
    expect(jpyRow!.foreignPerChf).toBeCloseTo(0.005901, 6);
  });

  it("toInserts inverts to <foreign>-base, CHF target", () => {
    const src = new SnbSource();
    const parsed = src.parseCsv(CSV);
    const rows = src.toInserts(parsed, "2026-05-27T00:00:00.000Z");
    const usd = rows.find((r) => r.source_currency === "USD" && r.bucket_ts === "2024-03-01T00:00:00.000Z");
    expect(usd).toBeDefined();
    expect(usd!.target_currency).toBe("CHF");
    // SNB published 0.8852 USD per 1 CHF -> 1/0.8852 CHF per 1 USD.
    expect(usd!.rate).toBeCloseTo(1 / 0.8852, 6);
    expect(usd!.source_authority).toBe("SNB");
    expect(usd!.product).toBe("ORBI-D-authority");
  });

  it("parseTable extracts rows from a rendered HTML table tuple", () => {
    const src = new SnbSource();
    const headers = ["Datum", "USD1", "EUR1", "JPY100"];
    const dataRows = [
      ["01.03.2024", "0.8852", "0.9587", "0.5901"],
      ["04.03.2024", "0.8810", "", ""],
    ];
    const parsed = src.parseTable(headers, dataRows);
    expect(parsed.length).toBeGreaterThanOrEqual(4);
    expect(parsed[0]!.date).toBe("2024-03-01");
  });

  it("fetchCsv throws a helpful fallback message when all candidates fail", async () => {
    const src = new SnbSource();
    const fetchImpl = async () => new Response("not found", { status: 404 });
    await expect(src.fetchCsv({ fetchImpl: fetchImpl as typeof fetch })).rejects.toThrow(
      /Playwright/,
    );
  });
});
