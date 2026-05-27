import { describe, expect, it } from "vitest";
import {
  BojSource,
  decodeShiftJis,
  normaliseDate,
  unitDirection,
} from "../../scripts/central-banks/sources/boj";

const CSV_USD = `"Series code","FM08'FXERATE@5USD"
"Title","Foreign Exchange Rates / 5pm Tokyo / U.S. dollar"
"Unit","Yen per US$"
"Frequency","Daily"
"Date","FM08'FXERATE@5USD"
"2024/03/01","150.32"
"2024/03/02","ND"
"2024/03/04","150.21"
`;

describe("BojSource", () => {
  it("normaliseDate accepts YYYY/MM/DD and ISO", () => {
    expect(normaliseDate("2024/03/01")).toBe("2024-03-01");
    expect(normaliseDate("2024-03-01")).toBe("2024-03-01");
    expect(normaliseDate("garbage")).toBeNull();
  });

  it("unitDirection picks the right normalisation rule", () => {
    expect(unitDirection("Yen per US$")).toBe("yen-per-foreign");
    expect(unitDirection("U.S. dollar per 100 yen")).toBe("foreign-per-100-yen");
    expect(unitDirection("")).toBe("yen-per-foreign");
  });

  it("urlFor builds the BoJ daily CSV download URL", () => {
    const src = new BojSource();
    const url = src.urlFor("USD/JPY", 1973, 2026);
    expect(url).toContain("cgi=%24nme_a000_en");
    expect(url).toContain("hdnYyyyFrom=1973");
    expect(url).toContain("hdnYyyyTo=2026");
    expect(url).toContain("chkFreq=DD");
    expect(decodeURIComponent(url)).toContain("FM08'FXERATE@5USD");
  });

  it("parseCsv reads Date / value rows and skips ND", () => {
    const src = new BojSource();
    const rows = src.parseCsv(CSV_USD, "USD/JPY");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.date).toBe("2024-03-01");
    // Unit is "Yen per US$" → 150.32 JPY per 1 USD → normalised to
    // foreignPer100Jpy = 100 / 150.32.
    expect(rows[0]!.foreignPer100Jpy).toBeCloseTo(100 / 150.32, 6);
  });

  it("toInserts converts back to JPY-per-foreign for storage", () => {
    const src = new BojSource();
    const parsed = src.parseCsv(CSV_USD, "USD/JPY");
    const rows = src.toInserts(parsed, "2026-05-27T00:00:00.000Z");
    expect(rows).toHaveLength(2);
    const first = rows[0]!;
    expect(first.source_currency).toBe("USD");
    expect(first.target_currency).toBe("JPY");
    expect(first.bucket_ts).toBe("2024-03-01T00:00:00.000Z");
    // Round-trip: 100 / (100 / 150.32) === 150.32 JPY per USD.
    expect(first.rate).toBeCloseTo(150.32, 6);
    expect(first.source_authority).toBe("BOJ");
    expect(first.product).toBe("ORBI-D-authority");
  });

  it("decodeShiftJis decodes Shift_JIS bytes (basic ASCII subset)", () => {
    // ASCII characters round-trip identically through shift_jis.
    const bytes = new TextEncoder().encode("hello,world\n");
    const decoded = decodeShiftJis(bytes.buffer);
    expect(decoded).toBe("hello,world\n");
  });

  it("parseCsv throws when 'Date' header row is absent", () => {
    const src = new BojSource();
    expect(() => src.parseCsv('"Series code","FOO"\n"Title","bar"\n', "USD/JPY")).toThrow(
      /missing 'Date' header row/,
    );
  });

  it("fetch propagates upstream non-200", async () => {
    const src = new BojSource();
    const fetchImpl = async () => new Response("nope", { status: 500 });
    await expect(
      src.fetch({ pair: "USD/JPY", yearFrom: 1973, yearTo: 2026, fetchImpl: fetchImpl as typeof fetch }),
    ).rejects.toThrow(/BoJ 500/);
  });
});
