import { describe, expect, it } from "vitest";
import { EcbSource } from "../../scripts/central-banks/sources/ecb";

// Trimmed ECB SDW CSV output for D.USD.EUR.SP00.A. Real responses ship
// 30+ columns; we only need TIME_PERIOD + OBS_VALUE.
const CSV_USD = `KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE
EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,1999-01-04,1.1789
EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2024-03-01,1.0840
EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2024-03-02,
EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2024-03-04,1.0855
`;

const CSV_GBP = `KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE
EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2024-03-01,0.8543
`;

describe("EcbSource", () => {
  it("urlFor builds the EXR endpoint with the correct series key", () => {
    const src = new EcbSource();
    const url = src.urlFor("USD/EUR", "1999-01-04", "2024-03-04");
    expect(url).toContain("/D.USD.EUR.SP00.A");
    expect(url).toContain("format=csvdata");
    expect(url).toContain("startPeriod=1999-01-04");
    expect(url).toContain("endPeriod=2024-03-04");
  });

  it("urlFor rejects unsupported pairs", () => {
    const src = new EcbSource();
    expect(() => src.urlFor("XYZ/EUR", "2024-01-01", "2024-02-01")).toThrow(
      /Unsupported ECB pair/,
    );
  });

  it("parseCsv tolerates missing OBS_VALUE rows", () => {
    const src = new EcbSource();
    const rows = src.parseCsv(CSV_USD);
    expect(rows).toHaveLength(3); // empty value row dropped
    expect(rows[0]).toEqual({ date: "1999-01-04", value: 1.1789 });
  });

  it("toInserts inverts USD/EUR (so rate = EUR per 1 USD)", () => {
    const src = new EcbSource();
    const rows = src.toInserts(CSV_USD, "2026-05-27T00:00:00.000Z", { pair: "USD/EUR" });
    expect(rows).toHaveLength(3);
    const first = rows[0]!;
    expect(first.source_currency).toBe("USD");
    expect(first.target_currency).toBe("EUR");
    expect(first.bucket_ts).toBe("1999-01-04T00:00:00.000Z");
    // ECB published 1.1789 USD per 1 EUR -> 1/1.1789 EUR per 1 USD.
    expect(first.rate).toBeCloseTo(1 / 1.1789, 6);
    expect(first.source_authority).toBe("ECB");
    expect(first.product).toBe("ORBI-D-authority");
    expect(first.tier).toBe("B-single");
    expect(first.provider_count).toBe(1);
  });

  it("toInserts stores EUR cross pairs as-is (no inversion)", () => {
    const src = new EcbSource();
    const rows = src.toInserts(CSV_GBP, "2026-05-27T00:00:00.000Z", { pair: "EUR/GBP" });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.source_currency).toBe("EUR");
    expect(r.target_currency).toBe("GBP");
    expect(r.rate).toBeCloseTo(0.8543, 6);
  });

  it("fetch propagates non-200 with status + body slice", async () => {
    const src = new EcbSource();
    const fetchImpl = async () => new Response("nope", { status: 503 });
    await expect(
      src.fetch({ pair: "USD/EUR", from: "2024-01-01", to: "2024-02-01", fetchImpl: fetchImpl as typeof fetch }),
    ).rejects.toThrow(/ECB 503/);
  });

  it("parseCsv throws on missing required columns", () => {
    const src = new EcbSource();
    expect(() => src.parseCsv("FOO,BAR\n1,2\n")).toThrow(/missing TIME_PERIOD/);
  });
});
