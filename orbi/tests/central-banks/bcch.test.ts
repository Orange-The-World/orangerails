import { describe, expect, it } from "vitest";
import { BcchSource, type BcchRawResponse } from "../../scripts/central-banks/sources/bcch";

const FIXTURE_2025: BcchRawResponse = {
  version: "1.7.0",
  autor: "mindicador.cl",
  codigo: "dolar",
  nombre: "Dólar observado",
  unidad_medida: "Pesos",
  serie: [
    // mindicador.cl returns newest-first; we test that the source sorts
    // ascending on parse.
    { fecha: "2025-12-30T03:00:00.000Z", valor: 911.18 },
    { fecha: "2025-12-29T03:00:00.000Z", valor: 904.54 },
    { fecha: "2025-12-26T03:00:00.000Z", valor: 905.04 },
    // No-data day: malformed observation gets dropped silently.
    { fecha: "2025-12-25T03:00:00.000Z" },
    // Garbage value: zero / negative dropped.
    { fecha: "2025-12-24T03:00:00.000Z", valor: 0 },
    // Garbage value: non-finite dropped.
    { fecha: "2025-12-23T03:00:00.000Z", valor: Number.NaN },
    { fecha: "2025-01-02T03:00:00.000Z", valor: 996.46 },
  ],
};

describe("BcchSource", () => {
  it("urlFor builds the year-keyed mindicador endpoint", () => {
    const src = new BcchSource();
    expect(src.urlFor(2025)).toBe("https://mindicador.cl/api/dolar/2025");
    expect(src.urlFor(2021)).toBe("https://mindicador.cl/api/dolar/2021");
  });

  it("urlFor rejects implausible years", () => {
    const src = new BcchSource();
    expect(() => src.urlFor(1900)).toThrow(/Invalid BCCH year/);
    expect(() => src.urlFor(2200)).toThrow(/Invalid BCCH year/);
    expect(() => src.urlFor(NaN)).toThrow(/Invalid BCCH year/);
  });

  it("parse sorts ascending and drops bad / no-data observations", () => {
    const src = new BcchSource();
    const rows = src.parse(FIXTURE_2025);
    expect(rows).toHaveLength(4); // 7 input minus 3 garbage rows
    expect(rows[0]).toEqual({ date: "2025-01-02", value: 996.46 });
    expect(rows[rows.length - 1]).toEqual({ date: "2025-12-30", value: 911.18 });
  });

  it("toInserts emits USD/CLP rows tagged with source_authority='BCCH'", () => {
    const src = new BcchSource();
    const rows = src.toInserts(FIXTURE_2025, "2026-05-27T00:00:00.000Z");
    expect(rows).toHaveLength(4);
    const first = rows[0]!;
    expect(first.source_currency).toBe("USD");
    expect(first.target_currency).toBe("CLP");
    expect(first.bucket_ts).toBe("2025-01-02T00:00:00.000Z");
    // mindicador publishes CLP per 1 USD — matches ORBI USD-base, no inversion.
    expect(first.rate).toBeCloseTo(996.46, 6);
    expect(first.source_authority).toBe("BCCH");
    expect(first.product).toBe("ORBI-D-authority");
    expect(first.tier).toBe("B-single");
    expect(first.granularity).toBe("1d");
    expect(first.provider_count).toBe(1);
    expect(first.provenance).toBe("historical-backfill");
    expect(first.status).toBe("CONFIRMED");
    expect(first.composite).toBe(false);
  });

  it("toInserts handles empty / missing serie gracefully", () => {
    const src = new BcchSource();
    expect(src.toInserts({}, "2026-05-27T00:00:00.000Z")).toEqual([]);
    expect(src.toInserts({ serie: [] }, "2026-05-27T00:00:00.000Z")).toEqual([]);
  });

  it("fetch propagates non-200 with status + body slice", async () => {
    const src = new BcchSource();
    const fetchImpl = async () => new Response("nope", { status: 503 });
    await expect(
      src.fetch({ year: 2025, fetchImpl: fetchImpl as typeof fetch }),
    ).rejects.toThrow(/BCCH\/mindicador 503/);
  });

  it("fetchRange walks each calendar year and filters to the window", async () => {
    const src = new BcchSource();
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      const year = Number(url.slice(-4));
      const body: BcchRawResponse = {
        serie: [
          { fecha: `${year}-06-15T03:00:00.000Z`, valor: 800 + year * 0.01 },
          { fecha: `${year}-01-05T03:00:00.000Z`, valor: 700 + year * 0.01 },
        ],
      };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const parsed = await src.fetchRange({
      from: "2023-02-01",
      to: "2024-12-31",
      fetchImpl,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/2023");
    expect(calls[1]).toContain("/2024");
    // 2023-01-05 filtered out (before from); 2024-06-15 + 2023-06-15 + 2024-01-05 kept.
    expect(parsed.map((r) => r.date)).toEqual([
      "2023-06-15",
      "2024-01-05",
      "2024-06-15",
    ]);
  });
});
