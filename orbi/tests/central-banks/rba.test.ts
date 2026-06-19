import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RbaSource,
  excelDateToIso,
  normaliseDate,
} from "../../scripts/central-banks/sources/rba";

// Compact RBA F11 CSV with the canonical header structure (Title +
// Description + ... + Series ID, then YYYY-MM-DD data rows).
const CSV = `Title,A$1=US$,A$1=JP YEN,A$1=Euro
Description,USD per AUD,Yen per AUD,Euro per AUD
Frequency,Daily,Daily,Daily
Type,Original,Original,Original
Units,$,Yen,Euro
Series ID,FXRUSD,FXRJPY,FXREUR
Publication,F11,F11,F11
Source,RBA,RBA,RBA
Mnemonic,USD,JPY,EUR
,,,
2024-03-01,0.6502,98.5,0.6011
2024-03-04,0.6537,n.a.,0.6020
2024-03-05,,,
`;

const FIXTURE_OLD = path.resolve(__dirname, "./fixtures/rba-f11hist-1969-2009.xls");
const FIXTURE_RECENT = path.resolve(__dirname, "./fixtures/rba-f11hist.xls");

describe("RbaSource", () => {
  it("normaliseDate accepts ISO and DD-MMM-YYYY", () => {
    expect(normaliseDate("2024-03-01")).toBe("2024-03-01");
    expect(normaliseDate("01-Mar-2024")).toBe("2024-03-01");
    expect(normaliseDate("garbage")).toBeNull();
  });

  it("excelDateToIso converts Excel serials and passes through strings", () => {
    // 40207 is 2010-01-29 in Excel's 1900-date system.
    expect(excelDateToIso(40207)).toBe("2010-01-29");
    expect(excelDateToIso("2024-03-01")).toBe("2024-03-01");
    expect(excelDateToIso(null)).toBeNull();
    expect(excelDateToIso("not-a-date")).toBeNull();
  });

  it("urlFor returns the F11 endpoints", () => {
    const src = new RbaSource();
    expect(src.urlFor("current")).toContain("/csv/f11.1-data.csv");
    expect(src.urlFor("historical-1969-2009")).toContain("/xls-hist/f11hist-1969-2009.xls");
    expect(src.urlFor("historical-recent")).toContain("/xls-hist/f11hist.xls");
  });

  it("isXls correctly classifies datasets", () => {
    const src = new RbaSource();
    expect(src.isXls("current")).toBe(false);
    expect(src.isXls("historical-1969-2009")).toBe(true);
    expect(src.isXls("historical-recent")).toBe(true);
  });

  it("parseCsv extracts USD column and skips n.a./empty", () => {
    const src = new RbaSource();
    const rows = src.parseCsv(CSV);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ date: "2024-03-01", audPerUsdInverse: 0.6502 });
  });

  it("toInserts inverts to USD-base AUD rate", () => {
    const src = new RbaSource();
    const rows = src.toInserts(CSV, "2026-05-27T00:00:00.000Z");
    expect(rows).toHaveLength(2);
    const first = rows[0]!;
    expect(first.source_currency).toBe("USD");
    expect(first.target_currency).toBe("AUD");
    expect(first.bucket_ts).toBe("2024-03-01T00:00:00.000Z");
    // RBA published 0.6502 USD per 1 AUD -> 1/0.6502 AUD per 1 USD.
    expect(first.rate).toBeCloseTo(1 / 0.6502, 6);
    expect(first.source_authority).toBe("RBA");
    expect(first.product).toBe("ORBI-D-authority");
  });

  it("fetch surfaces non-200 with a hint about Akamai", async () => {
    const src = new RbaSource();
    const fetchImpl = async () => new Response("blocked", { status: 403 });
    await expect(src.fetch({ fetchImpl: fetchImpl as typeof fetch })).rejects.toThrow(
      /RBA 403.*Akamai/,
    );
  });

  it("fetch rejects XLS datasets (use fetchXls instead)", async () => {
    const src = new RbaSource();
    await expect(
      src.fetch({ dataset: "historical-1969-2009" }),
    ).rejects.toThrow(/CSV datasets only/);
  });

  it("fetchXls rejects CSV datasets (use fetch instead)", async () => {
    const src = new RbaSource();
    await expect(
      src.fetchXls({ dataset: "current" }),
    ).rejects.toThrow(/XLS datasets only/);
  });

  it("fetchAll dedupes overlapping dates with CSV winning over XLS", async () => {
    const src = new RbaSource();
    const fetchImpl = async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("f11.1-data.csv")) {
        return new Response(
          `Title,A$1=USD\nDescription,AUD/USD\nFrequency,Daily\nType,Original\nUnits,USD\nSeries ID,FXRUSD\nPublication,F11\nSource,RBA\nMnemonic,USD\n,,\n2024-01-31,0.6601\n2024-02-29,0.6502\n`,
          { status: 200 },
        );
      }
      // For XLS endpoints, the test patches parseXls directly below.
      return new Response(new ArrayBuffer(8), { status: 200 });
    };
    // Stub the XLS parser to return controlled monthly rows so the test
    // doesn't depend on the actual fixture files.
    src.parseXls = (() => [
      { date: "2023-12-29", audPerUsdInverse: 0.6800 },
      // overlap — CSV should win:
      { date: "2024-01-31", audPerUsdInverse: 0.9999 },
    ]) as unknown as typeof src.parseXls;

    const { rows, perDataset } = await src.fetchAll({ fetchImpl: fetchImpl as typeof fetch });
    // historical-1969-2009 produces 2 rows, historical-recent produces 2 rows
    // (same stub), but their dates fully overlap, so they contribute 2 unique
    // dates; CSV adds one new date 2024-02-29 and overrides 2024-01-31.
    const dates = rows.map((r) => r.date);
    expect(dates).toEqual(["2023-12-29", "2024-01-31", "2024-02-29"]);
    const jan = rows.find((r) => r.date === "2024-01-31")!;
    // CSV value 0.6601 must have won over XLS stub 0.9999.
    expect(jan.audPerUsdInverse).toBe(0.6601);
    expect(perDataset.current.rows).toBe(2);
    expect(perDataset["historical-1969-2009"].rows).toBe(2);
    expect(perDataset["historical-recent"].rows).toBe(2);
  });

  it("fetchAll continues when one dataset fails", async () => {
    const src = new RbaSource();
    const fetchImpl = async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("f11.1-data.csv")) {
        return new Response("blocked", { status: 403 });
      }
      return new Response(new ArrayBuffer(8), { status: 200 });
    };
    src.parseXls = (() => [
      { date: "1970-01-31", audPerUsdInverse: 1.1138 },
    ]) as unknown as typeof src.parseXls;

    const logs: string[] = [];
    const { rows, perDataset } = await src.fetchAll({
      fetchImpl: fetchImpl as typeof fetch,
      log: (m) => logs.push(m),
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(perDataset.current.error).toMatch(/RBA 403/);
    expect(perDataset["historical-1969-2009"].rows).toBe(1);
    expect(logs.some((l) => l.includes("FAILED"))).toBe(true);
  });
});

// Integration-style tests against the real XLS fixtures. Skipped if the
// fixtures aren't present (e.g. in a slim CI clone).
const hasFixtures = existsSync(FIXTURE_OLD) && existsSync(FIXTURE_RECENT);
describe.skipIf(!hasFixtures)("RbaSource parseXls (fixture)", () => {
  it("parses the 1969-2009 historical XLS into monthly rows", () => {
    const src = new RbaSource();
    const buf = readFileSync(FIXTURE_OLD);
    const rows = src.parseXls(buf);
    expect(rows.length).toBeGreaterThan(450); // ~486 observed
    expect(rows[0]!.date).toBe("1969-07-31");
    expect(rows[0]!.audPerUsdInverse).toBeCloseTo(1.1138, 4);
    const last = rows[rows.length - 1]!;
    expect(last.date.startsWith("2009-")).toBe(true);
  });

  it("parses the recent (2010-current) historical XLS into monthly rows", () => {
    const src = new RbaSource();
    const buf = readFileSync(FIXTURE_RECENT);
    const rows = src.parseXls(buf);
    expect(rows.length).toBeGreaterThan(150); // ~196 observed in 2026-05
    expect(rows[0]!.date).toBe("2010-01-29");
    expect(rows[0]!.audPerUsdInverse).toBeCloseTo(0.8909, 4);
  });
});
