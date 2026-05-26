import { describe, expect, it } from "vitest";
import { BanxicoSource, parseBanxicoDate } from "../../scripts/central-banks/sources/banxico";

const FIXTURE = {
  bmx: {
    series: [
      {
        idSerie: "SF43718",
        titulo: "Tipo de cambio FIX",
        datos: [
          { fecha: "01/03/2024", dato: "16.9876" },
          { fecha: "02/03/2024", dato: "N/E" }, // weekend / no observation
          { fecha: "04/03/2024", dato: "16.9123" },
          { fecha: "05/03/2024", dato: "17.0042" },
        ],
      },
    ],
  },
};

describe("BanxicoSource", () => {
  it("parseBanxicoDate converts DD/MM/YYYY to YYYY-MM-DD", () => {
    expect(parseBanxicoDate("01/03/2024")).toBe("2024-03-01");
    expect(parseBanxicoDate("31/12/1999")).toBe("1999-12-31");
    expect(parseBanxicoDate("garbage")).toBeNull();
  });

  it("urlFor builds the SIE endpoint with series SF43718", () => {
    const src = new BanxicoSource();
    const url = src.urlFor("2024-01-01", "2024-12-31");
    expect(url).toContain("/SF43718/datos/2024-01-01/2024-12-31");
  });

  it("fetch sends Bmx-Token header and parses JSON", async () => {
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Bmx-Token")).toBe("test-token");
      return new Response(JSON.stringify(FIXTURE), { status: 200 });
    };
    const src = new BanxicoSource();
    const raw = await src.fetch({
      from: "2024-03-01",
      to: "2024-03-05",
      token: "test-token",
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(raw.bmx?.series?.[0]?.datos).toHaveLength(4);
  });

  it("fetch throws when token is missing with a helpful message", async () => {
    const src = new BanxicoSource();
    await expect(
      src.fetch({ from: "2024-01-01", to: "2024-01-02", token: "" }),
    ).rejects.toThrow(/BANXICO_API_TOKEN missing/);
  });

  it("toInserts maps observations, skips N/E, tags BANXICO/ORBI-D-authority", () => {
    const src = new BanxicoSource();
    const rows = src.toInserts(FIXTURE, "2026-05-26T00:00:00.000Z");
    expect(rows).toHaveLength(3); // N/E filtered

    const first = rows[0]!;
    expect(first.source_currency).toBe("USD");
    expect(first.target_currency).toBe("MXN");
    expect(first.bucket_ts).toBe("2024-03-01T00:00:00.000Z");
    expect(first.rate).toBeCloseTo(16.9876, 6);
    expect(first.product).toBe("ORBI-D-authority");
    expect(first.granularity).toBe("1d");
    expect(first.source_authority).toBe("BANXICO");
    expect(first.provenance).toBe("historical-backfill");
    expect(first.tier).toBe("B-single");
    expect(first.provider_count).toBe(1);
    expect(first.composite).toBe(false);
    expect(first.status).toBe("CONFIRMED");
  });

  it("toInserts handles empty / malformed response without throwing", () => {
    const src = new BanxicoSource();
    expect(src.toInserts({}, "now")).toEqual([]);
    expect(src.toInserts({ bmx: { series: [] } }, "now")).toEqual([]);
  });
});
