import { describe, expect, it } from "vitest";
import { RbaSource, normaliseDate } from "../../scripts/central-banks/sources/rba";

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

describe("RbaSource", () => {
  it("normaliseDate accepts ISO and DD-MMM-YYYY", () => {
    expect(normaliseDate("2024-03-01")).toBe("2024-03-01");
    expect(normaliseDate("01-Mar-2024")).toBe("2024-03-01");
    expect(normaliseDate("garbage")).toBeNull();
  });

  it("urlFor returns the F11 current-data CSV", () => {
    const src = new RbaSource();
    expect(src.urlFor("current")).toContain("/csv/f11.1-data.csv");
    expect(src.urlFor("historical-1969-2009")).toContain("f11hist-1969-2009.csv");
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

  it("fetch surfaces 403 with a hint about Akamai", async () => {
    const src = new RbaSource();
    const fetchImpl = async () => new Response("blocked", { status: 403 });
    await expect(src.fetch({ fetchImpl: fetchImpl as typeof fetch })).rejects.toThrow(
      /RBA 403.*Akamai/,
    );
  });
});
