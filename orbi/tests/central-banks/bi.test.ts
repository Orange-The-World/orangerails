import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BiSource,
  extractViewState,
  isoDateOrNull,
  parseJisdorXlsx,
  parseSharedStrings,
  parseUsDateToIso,
  toDmy,
  type BiObservation,
} from "../../scripts/central-banks/sources/bi";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Real BI JISDOR XLSX captured 2026-05-28 by POSTing
 *   TextBoxFrom=01/01/2021, TextBoxDateTo=31/01/2021, ButtonExport=Unduh
 * to https://www.bi.go.id/id/statistik/informasi-kurs/jisdor/default.aspx
 * and saving the raw response body. Contains 20 JISDOR business-day
 * publication rows for January 2021 (newest-first in the workbook).
 */
const FIXTURE_PATH = join(__dirname, "bi-jan2021.xlsx");

describe("BiSource utility helpers", () => {
  it("isoDateOrNull accepts real dates and rejects impossible ones", () => {
    expect(isoDateOrNull(2025, 1, 1)).toBe("2025-01-01");
    expect(isoDateOrNull(2024, 12, 31)).toBe("2024-12-31");
    expect(isoDateOrNull(2025, 2, 30)).toBeNull();
    expect(isoDateOrNull(2025, 4, 31)).toBeNull();
    expect(isoDateOrNull(2025, 13, 1)).toBeNull();
  });

  it("toDmy formats ISO dates the way BI's TextBox widgets expect", () => {
    expect(toDmy("2026-05-27")).toBe("27/05/2026");
    expect(toDmy("2021-01-04")).toBe("04/01/2021");
  });

  it("parseUsDateToIso handles BI's US-locale export format", () => {
    expect(parseUsDateToIso("1/29/2021 12:00:00 AM")).toBe("2021-01-29");
    expect(parseUsDateToIso("12/31/2024 12:00:00 AM")).toBe("2024-12-31");
    expect(parseUsDateToIso("5/4/2026 12:00:00 AM")).toBe("2026-05-04");
    // Impossible dates and malformed inputs both yield null.
    expect(parseUsDateToIso("2/30/2025 12:00:00 AM")).toBeNull();
    expect(parseUsDateToIso("not a date")).toBeNull();
    expect(parseUsDateToIso("")).toBeNull();
  });
});

describe("parseSharedStrings", () => {
  it("flattens single-<t> entries into an index-ordered array", () => {
    const xml = `<?xml version="1.0"?>
      <sst><si><t>NO</t></si><si><t>Tanggal</t></si><si><t>Kurs</t></si></sst>`;
    expect(parseSharedStrings(xml)).toEqual(["NO", "Tanggal", "Kurs"]);
  });

  it("concatenates multi-run <r><t>…</t></r> entries (Excel rich-text)", () => {
    const xml = `<?xml version="1.0"?>
      <sst><si><r><t>foo</t></r><r><t>bar</t></r></si></sst>`;
    expect(parseSharedStrings(xml)).toEqual(["foobar"]);
  });
});

describe("extractViewState", () => {
  it("pulls the ASP.NET viewstate triple regardless of attribute order", () => {
    const html =
      `<input type="hidden" name="__VIEWSTATE" value="VS123" />` +
      `<input name="__VIEWSTATEGENERATOR" type="hidden" value="GEN456" />` +
      `<input type="hidden" name="__EVENTVALIDATION" value="EV789" />`;
    expect(extractViewState(html)).toEqual({
      __VIEWSTATE: "VS123",
      __VIEWSTATEGENERATOR: "GEN456",
      __EVENTVALIDATION: "EV789",
    });
  });

  it("throws when any of the three fields is missing", () => {
    const html = `<input type="hidden" name="__VIEWSTATE" value="x" />`;
    expect(() => extractViewState(html)).toThrow(
      /viewstate field __VIEWSTATEGENERATOR not found/,
    );
  });
});

describe("parseJisdorXlsx (live BI fixture)", () => {
  it("extracts every JISDOR publication date in the workbook", () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE_PATH));
    const rows = parseJisdorXlsx(bytes);
    // BI published 20 JISDOR business-day rates for January 2021:
    // Jan 4-8, 11-15, 18-22, 25-29 (5 trading weeks).
    expect(rows).toHaveLength(20);
    // Output must be ascending by date.
    expect(rows[0]!.date).toBe("2021-01-04");
    expect(rows[rows.length - 1]!.date).toBe("2021-01-29");
    // Spot-check a few rates against the live HTML table values seen on
    // 2026-05-28 at /id/statistik/informasi-kurs/jisdor/default.aspx:
    //   29 Januari 2021 -> Rp14.084,00
    //   28 Januari 2021 -> Rp14.119,00
    //    4 Januari 2021 -> Rp13.903,00
    const byDate = new Map(rows.map((r) => [r.date, r.rate]));
    expect(byDate.get("2021-01-04")).toBe(13903);
    expect(byDate.get("2021-01-28")).toBe(14119);
    expect(byDate.get("2021-01-29")).toBe(14084);
  });

  it("drops the header row (col C is a shared-string label, not numeric)", () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE_PATH));
    const rows = parseJisdorXlsx(bytes);
    // None of the parsed rows should have a non-finite or non-positive
    // rate (would indicate the "Kurs" header leaked through).
    for (const r of rows) {
      expect(Number.isFinite(r.rate)).toBe(true);
      expect(r.rate).toBeGreaterThan(0);
    }
  });
});

describe("BiSource.toInserts", () => {
  it("emits USD/IDR rows tagged with source_authority='BI'", () => {
    const src = new BiSource();
    const observations: BiObservation[] = [
      { date: "2025-01-02", rate: 16210 },
      { date: "2025-01-03", rate: 16240 },
    ];
    const rows = src.toInserts(observations, "2026-05-27T00:00:00.000Z");
    expect(rows).toHaveLength(2);
    const first = rows[0]!;
    expect(first.source_currency).toBe("USD");
    expect(first.target_currency).toBe("IDR");
    expect(first.bucket_ts).toBe("2025-01-02T00:00:00.000Z");
    expect(first.rate).toBe(16210);
    expect(first.source_authority).toBe("BI");
    expect(first.product).toBe("ORBI-D-authority");
    expect(first.tier).toBe("B-single");
    expect(first.granularity).toBe("1d");
    expect(first.provider_count).toBe(1);
    expect(first.provenance).toBe("historical-backfill");
    expect(first.status).toBe("CONFIRMED");
    expect(first.composite).toBe(false);
  });

  it("drops non-finite and non-positive rates", () => {
    const src = new BiSource();
    const observations: BiObservation[] = [
      { date: "2025-01-02", rate: Number.NaN },
      { date: "2025-01-03", rate: 0 },
      { date: "2025-01-04", rate: -16000 },
      { date: "2025-01-05", rate: 16205 },
    ];
    const rows = src.toInserts(observations, "2026-05-27T00:00:00.000Z");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bucket_ts).toBe("2025-01-05T00:00:00.000Z");
    expect(rows[0]!.rate).toBe(16205);
  });
});

describe("BiSource.fetchRange", () => {
  it("posts to the canonical JISDOR URL with the Unduh button + a browser UA", async () => {
    const src = new BiSource();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const xlsxBytes = readFileSync(FIXTURE_PATH);
    const html =
      `<input type="hidden" name="__VIEWSTATE" value="VS" />` +
      `<input type="hidden" name="__VIEWSTATEGENERATOR" value="VG" />` +
      `<input type="hidden" name="__EVENTVALIDATION" value="EV" />`;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      // First call = GET landing (HTML); second call = POST export (XLSX).
      if (!init || (init.method ?? "GET").toUpperCase() === "GET") {
        return new Response(html, { status: 200 });
      }
      return new Response(new Uint8Array(xlsxBytes), { status: 200 });
    }) as unknown as typeof fetch;

    const rows = await src.fetchRange({
      from: "2021-01-01",
      to: "2021-01-31",
      fetchImpl,
    });
    expect(rows).toHaveLength(20);
    expect(rows[0]!.date).toBe("2021-01-04");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(
      "https://www.bi.go.id/id/statistik/informasi-kurs/jisdor/default.aspx",
    );
    expect((calls[1]!.init?.method ?? "").toUpperCase()).toBe("POST");
    const headers = (calls[1]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/Chrome\//);
    expect(headers["User-Agent"]).toMatch(/Orange-Rails-ORBI/);
    // POST body must carry the Unduh button + correctly formatted dates.
    const bodyStr = String(calls[1]!.init?.body ?? "");
    expect(bodyStr).toContain("ButtonExport=Unduh");
    expect(bodyStr).toContain("TextBoxFrom=01%2F01%2F2021");
    expect(bodyStr).toContain("TextBoxDateTo=31%2F01%2F2021");
  });

  it("filters returned observations to the inclusive [from, to] window", async () => {
    const src = new BiSource();
    const xlsxBytes = readFileSync(FIXTURE_PATH);
    const html =
      `<input type="hidden" name="__VIEWSTATE" value="VS" />` +
      `<input type="hidden" name="__VIEWSTATEGENERATOR" value="VG" />` +
      `<input type="hidden" name="__EVENTVALIDATION" value="EV" />`;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (!init || (init.method ?? "GET").toUpperCase() === "GET") {
        return new Response(html, { status: 200 });
      }
      return new Response(new Uint8Array(xlsxBytes), { status: 200 });
    }) as unknown as typeof fetch;
    const rows = await src.fetchRange({
      from: "2021-01-15",
      to: "2021-01-22",
      fetchImpl,
    });
    expect(rows.map((r) => r.date)).toEqual([
      "2021-01-15",
      "2021-01-18",
      "2021-01-19",
      "2021-01-20",
      "2021-01-21",
      "2021-01-22",
    ]);
  });

  it("rejects ranges where from > to or formats are invalid", async () => {
    const src = new BiSource();
    await expect(
      src.fetchRange({ from: "2024-06-30", to: "2024-06-01" }),
    ).rejects.toThrow(/Invalid BI range/);
    await expect(
      src.fetchRange({ from: "2024-1-1", to: "2024-12-31" }),
    ).rejects.toThrow(/Invalid BI range/);
  });

  it("propagates a non-200 GET with status + body slice", async () => {
    const src = new BiSource();
    const fetchImpl = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(
      src.fetchRange({ from: "2024-01-01", to: "2024-01-31", fetchImpl }),
    ).rejects.toThrow(/BI JISDOR GET 503/);
  });
});
