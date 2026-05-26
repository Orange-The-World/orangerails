import { describe, expect, it } from "vitest";
import {
  BankOfEnglandSource,
  fromBoeDate,
  parseBoeCsv,
  toBoeDate,
} from "../../scripts/central-banks/sources/bank-of-england";

const CSV_FIXTURE = `DATE,XUDLGBD
02 Jan 2024,0.7921
03 Jan 2024,0.7919
04 Jan 2024,0.7875
05 Jan 2024,0.7842
08 Jan 2024,
09 Jan 2024,0.7860
`;

describe("BankOfEnglandSource", () => {
  it("toBoeDate converts ISO to BoE DD/Mon/YYYY", () => {
    expect(toBoeDate("2024-01-02")).toBe("02/Jan/2024");
    expect(toBoeDate("1999-12-31")).toBe("31/Dec/1999");
  });

  it("toBoeDate rejects bad input", () => {
    expect(() => toBoeDate("2024/01/02")).toThrow(/Invalid ISO date/);
    expect(() => toBoeDate("2024-13-01")).toThrow(/Invalid month/);
  });

  it("fromBoeDate converts BoE format to ISO", () => {
    expect(fromBoeDate("02 Jan 2024")).toBe("2024-01-02");
    expect(fromBoeDate("31 Dec 1999")).toBe("1999-12-31");
    expect(fromBoeDate("2 Mar 2024")).toBe("2024-03-02");
  });

  it("fromBoeDate rejects bad input", () => {
    expect(() => fromBoeDate("garbage")).toThrow(/Unrecognised BoE date/);
    expect(() => fromBoeDate("01 Xyz 2024")).toThrow(/Unrecognised month/);
  });

  it("urlFor builds the IADB CSV endpoint", () => {
    const src = new BankOfEnglandSource();
    const url = src.urlFor("2024-01-01", "2024-12-31");
    expect(url).toContain("/boeapps/iadb/fromshowcolumns.asp?");
    expect(url).toContain("csv.x=yes");
    expect(url).toContain("Datefrom=01%2FJan%2F2024");
    expect(url).toContain("Dateto=31%2FDec%2F2024");
    expect(url).toContain("SeriesCodes=XUDLGBD");
    expect(url).toContain("UsingCodes=Y");
    expect(url).toContain("CSVF=TN");
  });

  it("urlFor honours an explicit seriesCode", () => {
    const src = new BankOfEnglandSource();
    const url = src.urlFor("2024-01-01", "2024-01-31", "XUDLERD");
    expect(url).toContain("SeriesCodes=XUDLERD");
  });

  it("parseBoeCsv skips header, empty cells, blank lines", () => {
    const rows = parseBoeCsv(CSV_FIXTURE);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({ date: "2024-01-02", rate: 0.7921 });
    expect(rows[4]).toEqual({ date: "2024-01-09", rate: 0.786 });
  });

  it("parseBoeCsv handles a body with only the header", () => {
    expect(parseBoeCsv("DATE,XUDLGBD\n")).toEqual([]);
  });

  it("toInserts maps rows and tags BOE/USD/GBP/ORBI-D-authority", () => {
    const src = new BankOfEnglandSource();
    const rows = src.toInserts(CSV_FIXTURE, "2026-05-26T00:00:00.000Z");
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.source_currency).toBe("USD");
      expect(r.target_currency).toBe("GBP");
      expect(r.source_authority).toBe("BOE");
      expect(r.product).toBe("ORBI-D-authority");
      expect(r.granularity).toBe("1d");
      expect(r.tier).toBe("B-single");
      expect(r.provider_count).toBe(1);
      expect(r.composite).toBe(false);
      expect(r.status).toBe("CONFIRMED");
      expect(r.provenance).toBe("historical-backfill");
    }
    expect(rows[0]!.bucket_ts).toBe("2024-01-02T00:00:00.000Z");
    expect(rows[0]!.rate).toBeCloseTo(0.7921, 6);
  });

  it("toInserts honours an alternate target currency", () => {
    const src = new BankOfEnglandSource();
    const rows = src.toInserts(CSV_FIXTURE, "2026-05-26T00:00:00.000Z", {
      target: "EUR",
    });
    expect(rows[0]!.target_currency).toBe("EUR");
  });

  it("fetch returns the CSV body", async () => {
    const fetchImpl = (async () =>
      new Response(CSV_FIXTURE, {
        status: 200,
        headers: { "content-type": "text/csv" },
      })) as typeof fetch;
    const src = new BankOfEnglandSource();
    const body = await src.fetch({
      from: "2024-01-02",
      to: "2024-01-09",
      fetchImpl,
    });
    expect(body).toBe(CSV_FIXTURE);
  });

  it("fetch throws on non-OK", async () => {
    const fetchImpl = (async () =>
      new Response("oops", { status: 503 })) as typeof fetch;
    const src = new BankOfEnglandSource();
    await expect(
      src.fetch({ from: "2024-01-02", to: "2024-01-09", fetchImpl }),
    ).rejects.toThrow(/Bank of England 503/);
  });
});
