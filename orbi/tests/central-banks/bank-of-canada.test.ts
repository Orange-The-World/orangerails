import { describe, expect, it } from "vitest";
import { BankOfCanadaSource } from "../../scripts/central-banks/sources/bank-of-canada";

const FIXTURE = {
  observations: [
    { d: "2024-03-01", FXUSDCAD: { v: "1.3582" } },
    { d: "2024-03-04", FXUSDCAD: { v: "1.3551" } },
    { d: "2024-03-05", FXUSDCAD: { v: "1.3601" } },
    { d: "2024-03-06", FXUSDCAD: { v: "" } }, // missing observation (e.g. holiday)
  ],
};

describe("BankOfCanadaSource", () => {
  it("urlFor builds the Valet endpoint with FXUSDCAD series", () => {
    const src = new BankOfCanadaSource();
    const url = src.urlFor("2024-01-01", "2024-12-31");
    expect(url).toContain("/valet/observations/FXUSDCAD/json");
    expect(url).toContain("start_date=2024-01-01");
    expect(url).toContain("end_date=2024-12-31");
  });

  it("toInserts maps observations and skips empty values", () => {
    const src = new BankOfCanadaSource();
    const rows = src.toInserts(FIXTURE, "2026-05-26T00:00:00.000Z");
    expect(rows).toHaveLength(3); // the empty `v` row is skipped

    expect(rows[0]!.bucket_ts).toBe("2024-03-01T00:00:00.000Z");
    expect(rows[0]!.rate).toBeCloseTo(1.3582, 6);
    expect(rows[2]!.rate).toBeCloseTo(1.3601, 6);
  });

  it("toInserts tags BOC authority + USD/CAD + ORBI-D-authority", () => {
    const src = new BankOfCanadaSource();
    const rows = src.toInserts(FIXTURE, "2026-05-26T00:00:00.000Z");
    for (const r of rows) {
      expect(r.source_currency).toBe("USD");
      expect(r.target_currency).toBe("CAD");
      expect(r.source_authority).toBe("BOC");
      expect(r.product).toBe("ORBI-D-authority");
      expect(r.granularity).toBe("1d");
      expect(r.provenance).toBe("historical-backfill");
      expect(r.tier).toBe("B-single");
      expect(r.provider_count).toBe(1);
      expect(r.composite).toBe(false);
      expect(r.status).toBe("CONFIRMED");
    }
  });

  it("fetch parses JSON", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(FIXTURE), { status: 200 })) as typeof fetch;
    const src = new BankOfCanadaSource();
    const raw = await src.fetch({ from: "2024-03-01", to: "2024-03-06", fetchImpl });
    expect(raw.observations).toHaveLength(4);
  });

  it("fetch throws on non-OK", async () => {
    const fetchImpl = (async () => new Response("oops", { status: 500 })) as typeof fetch;
    const src = new BankOfCanadaSource();
    await expect(
      src.fetch({ from: "2024-03-01", to: "2024-03-06", fetchImpl }),
    ).rejects.toThrow(/Bank of Canada 500/);
  });

  it("toInserts handles empty response", () => {
    const src = new BankOfCanadaSource();
    expect(src.toInserts({}, "now")).toEqual([]);
    expect(src.toInserts({ observations: [] }, "now")).toEqual([]);
  });
});
