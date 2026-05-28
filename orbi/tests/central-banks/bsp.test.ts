import { describe, expect, it } from "vitest";
import {
  BspSource,
  isoDateOrNull,
  monthNumber,
  parseDailySheetXml,
  type BspDailyObservation,
} from "../../scripts/central-banks/sources/bsp";

/**
 * Synthetic worksheet XML mimicking BSP's pesodollar.xlsx daily-sheet
 * layout: each year block has a year-header row (col A = year), a "Day"
 * label row (col A = "Day" as shared-string), then up to 31 day rows
 * (col A = 1..31, cols B..M = Jan..Dec USD/PHP rates).
 *
 * We model a tiny two-year block (2024 and 2025) with a handful of
 * observations plus one shared-string ("..") no-data cell to assert the
 * filter path. Cells outside the test window must be excluded by the
 * (from, to) bounds.
 */
const FIXTURE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c></row>
    <row r="2"><c r="A2"><v>2025</v></c></row>
    <row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3" t="s"><v>2</v></c></row>
    <row r="4"><c r="A4"><v>1</v></c><c r="B4"><v>56.50</v></c><c r="M4"><v>58.20</v></c></row>
    <row r="5"><c r="A5"><v>2</v></c><c r="B5"><v>56.55</v></c><c r="B5_extra" t="s"><v>3</v></c></row>
    <row r="6"><c r="A6"><v>15</v></c><c r="F6" t="s"><v>4</v></c></row>
    <row r="40"><c r="A40"><v>2024</v></c></row>
    <row r="41"><c r="A41" t="s"><v>5</v></c></row>
    <row r="42"><c r="A42"><v>1</v></c><c r="B42"><v>55.10</v></c></row>
    <row r="43"><c r="A43"><v>31</v></c><c r="M43"><v>57.30</v></c></row>
  </sheetData>
</worksheet>`;

describe("BspSource utilities", () => {
  it("isoDateOrNull accepts real dates and rejects impossible ones", () => {
    expect(isoDateOrNull(2025, 1, 1)).toBe("2025-01-01");
    expect(isoDateOrNull(2024, 12, 31)).toBe("2024-12-31");
    expect(isoDateOrNull(2025, 2, 30)).toBeNull();
    expect(isoDateOrNull(2025, 4, 31)).toBeNull();
    expect(isoDateOrNull(2025, 13, 1)).toBeNull();
  });

  it("monthNumber maps abbreviations case-sensitively and rejects unknowns", () => {
    expect(monthNumber("Jan")).toBe(1);
    expect(monthNumber("December")).toBe(12);
    expect(monthNumber("xyz")).toBeNull();
  });
});

describe("parseDailySheetXml", () => {
  it("extracts numeric (day, month) observations across year blocks", () => {
    const rows = parseDailySheetXml(FIXTURE_XML, "2024-01-01", "2025-12-31");
    // Expected observations (sorted ascending):
    //   2024-01-01 = 55.10  (year=2024 row42 colB)
    //   2024-12-31 = 57.30  (year=2024 row43 colM)
    //   2025-01-01 = 56.50  (year=2025 row4 colB)
    //   2025-01-02 = 56.55  (year=2025 row5 colB)
    //   2025-12-01 = 58.20  (year=2025 row4 colM)
    // Shared-string col F (no-data ".."), col A "Day" header, and the
    // out-of-month "15/Jun" with a shared-string value all get dropped.
    expect(rows.map((r) => r.date)).toEqual([
      "2024-01-01",
      "2024-12-31",
      "2025-01-01",
      "2025-01-02",
      "2025-12-01",
    ]);
    expect(rows[0]!.rate).toBeCloseTo(55.1, 6);
    expect(rows[4]!.rate).toBeCloseTo(58.2, 6);
  });

  it("respects the (from, to) window", () => {
    const rows = parseDailySheetXml(FIXTURE_XML, "2025-01-01", "2025-12-31");
    expect(rows.map((r) => r.date)).toEqual([
      "2025-01-01",
      "2025-01-02",
      "2025-12-01",
    ]);
  });

  it("drops impossible (day, month) combinations", () => {
    // Year block where row 4 col B/C/D points at Jan 31 / Feb 31 / Mar 31.
    // Feb 31 must be silently dropped.
    const xml = `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="2"><c r="A2"><v>2025</v></c></row>
    <row r="3"><c r="A3" t="s"><v>0</v></c></row>
    <row r="4"><c r="A4"><v>31</v></c><c r="B4"><v>56.0</v></c><c r="C4"><v>56.1</v></c><c r="D4"><v>56.2</v></c></row>
  </sheetData>
</worksheet>`;
    const rows = parseDailySheetXml(xml, "2025-01-01", "2025-12-31");
    expect(rows.map((r) => r.date)).toEqual(["2025-01-31", "2025-03-31"]);
  });
});

describe("BspSource.toInserts", () => {
  it("emits USD/PHP rows tagged with source_authority='BSP'", () => {
    const src = new BspSource();
    const observations: BspDailyObservation[] = [
      { date: "2025-01-02", rate: 56.55 },
      { date: "2025-01-03", rate: 56.62 },
    ];
    const rows = src.toInserts(observations, "2026-05-27T00:00:00.000Z");
    expect(rows).toHaveLength(2);
    const first = rows[0]!;
    expect(first.source_currency).toBe("USD");
    expect(first.target_currency).toBe("PHP");
    expect(first.bucket_ts).toBe("2025-01-02T00:00:00.000Z");
    expect(first.rate).toBeCloseTo(56.55, 6);
    expect(first.source_authority).toBe("BSP");
    expect(first.product).toBe("ORBI-D-authority");
    expect(first.tier).toBe("B-single");
    expect(first.granularity).toBe("1d");
    expect(first.provider_count).toBe(1);
    expect(first.provenance).toBe("historical-backfill");
    expect(first.status).toBe("CONFIRMED");
    expect(first.composite).toBe(false);
  });

  it("drops non-finite and non-positive rates", () => {
    const src = new BspSource();
    const observations: BspDailyObservation[] = [
      { date: "2025-01-02", rate: Number.NaN },
      { date: "2025-01-03", rate: 0 },
      { date: "2025-01-04", rate: -56 },
      { date: "2025-01-05", rate: 56.7 },
    ];
    const rows = src.toInserts(observations, "2026-05-27T00:00:00.000Z");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bucket_ts).toBe("2025-01-05T00:00:00.000Z");
  });
});

describe("BspSource.fetch", () => {
  it("propagates non-200 with status + body slice", async () => {
    const src = new BspSource();
    const fetchImpl = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(src.fetch({ fetchImpl })).rejects.toThrow(/BSP 503/);
  });

  it("hits the canonical pesodollar.xlsx URL with a polite UA", async () => {
    const src = new BspSource();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      // Return an empty (but well-formed) Uint8Array; the test asserts the
      // request shape only, not the workbook contents.
      return new Response(new Uint8Array(0), { status: 200 });
    }) as unknown as typeof fetch;
    await src.fetch({ fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://www.bsp.gov.ph/statistics/external/pesodollar.xlsx",
    );
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/Orange-Rails-ORBI/);
  });
});
