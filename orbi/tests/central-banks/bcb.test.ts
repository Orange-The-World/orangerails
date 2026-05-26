import { describe, expect, it } from "vitest";
import { BcbSource, toMdy } from "../../scripts/central-banks/sources/bcb";

const FIXTURE = {
  value: [
    {
      cotacaoCompra: 5.0512,
      cotacaoVenda: 5.0518,
      dataHoraCotacao: "2024-03-01 10:08:23.123",
      tipoBoletim: "Abertura",
    },
    {
      cotacaoCompra: 5.0601,
      cotacaoVenda: 5.0607,
      dataHoraCotacao: "2024-03-01 13:09:23.477",
      tipoBoletim: "Fechamento",
    },
    {
      cotacaoCompra: 5.0301,
      cotacaoVenda: 5.0306,
      dataHoraCotacao: "2024-03-04 13:11:00.000",
      tipoBoletim: "Fechamento",
    },
    {
      cotacaoCompra: 5.0210,
      cotacaoVenda: 5.0215,
      dataHoraCotacao: "2024-03-05 10:00:00.000",
      tipoBoletim: "Intermediário",
    },
  ],
};

describe("BcbSource", () => {
  it("toMdy converts YYYY-MM-DD → MM-DD-YYYY", () => {
    expect(toMdy("2024-03-01")).toBe("03-01-2024");
    expect(() => toMdy("garbage")).toThrow();
  });

  it("urlFor builds the OData URL with MM-DD-YYYY formatted bounds", () => {
    const src = new BcbSource();
    const url = src.urlFor("2024-01-01", "2024-12-31");
    expect(url).toContain("@dataInicial='01-01-2024'");
    expect(url).toContain("@dataFinalCotacao='12-31-2024'");
    expect(url).toContain("$format=json");
  });

  it("toInserts uses cotacaoVenda (selling rate) and prefers Fechamento", () => {
    const src = new BcbSource();
    const rows = src.toInserts(FIXTURE, "2026-05-26T00:00:00.000Z");
    // 3 distinct dates: 2024-03-01, 2024-03-04, 2024-03-05
    expect(rows).toHaveLength(3);

    const mar1 = rows.find((r) => r.bucket_ts === "2024-03-01T00:00:00.000Z")!;
    // Fechamento wins for 2024-03-01: venda = 5.0607, not the Abertura 5.0518.
    expect(mar1.rate).toBeCloseTo(5.0607, 6);

    // 2024-03-05 has no Fechamento — falls back to the only available row.
    const mar5 = rows.find((r) => r.bucket_ts === "2024-03-05T00:00:00.000Z")!;
    expect(mar5.rate).toBeCloseTo(5.0215, 6);
  });

  it("toInserts tags BCB authority + ORBI-D-authority product + USD/BRL pair", () => {
    const src = new BcbSource();
    const rows = src.toInserts(FIXTURE, "2026-05-26T00:00:00.000Z");
    for (const r of rows) {
      expect(r.source_currency).toBe("USD");
      expect(r.target_currency).toBe("BRL");
      expect(r.source_authority).toBe("BCB");
      expect(r.product).toBe("ORBI-D-authority");
      expect(r.granularity).toBe("1d");
      expect(r.provenance).toBe("historical-backfill");
      expect(r.tier).toBe("B-single");
      expect(r.provider_count).toBe(1);
    }
  });

  it("fetch parses JSON response", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(FIXTURE), { status: 200 })) as typeof fetch;
    const src = new BcbSource();
    const raw = await src.fetch({ from: "2024-03-01", to: "2024-03-05", fetchImpl });
    expect(raw.value).toHaveLength(4);
  });

  it("toInserts handles empty response gracefully", () => {
    const src = new BcbSource();
    expect(src.toInserts({}, "now")).toEqual([]);
    expect(src.toInserts({ value: [] }, "now")).toEqual([]);
  });
});
