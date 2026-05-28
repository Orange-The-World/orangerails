import { describe, expect, it } from "vitest";
import {
  BanrepSource,
  iterateDays,
  isoDateOnly,
  shiftIsoDay,
  type BanrepRawObservation,
} from "../../scripts/central-banks/sources/banrep";

// Mirrors the real Socrata response shape, including the Friday-covers-
// the-weekend pattern that drives the interval-expansion logic, and the
// "valor as string" quirk that the SODA2 API actually uses in prod.
const FIXTURE: BanrepRawObservation[] = [
  // Friday Dec 31 2020 covers the New-Year holiday through Jan 4 2021.
  {
    valor: "3432.5",
    unidad: "COP",
    vigenciadesde: "2020-12-31T00:00:00.000",
    vigenciahasta: "2021-01-04T00:00:00.000",
  },
  // Single-day weekday rows.
  {
    valor: "3420.78",
    unidad: "COP",
    vigenciadesde: "2021-01-05T00:00:00.000",
    vigenciahasta: "2021-01-05T00:00:00.000",
  },
  {
    valor: "3450.74",
    unidad: "COP",
    vigenciadesde: "2021-01-06T00:00:00.000",
    vigenciahasta: "2021-01-06T00:00:00.000",
  },
  // Friday-to-Monday weekend row.
  {
    valor: 3478.11,
    unidad: "COP",
    vigenciadesde: "2021-01-08T00:00:00.000",
    vigenciahasta: "2021-01-11T00:00:00.000",
  },
  // Garbage rows — must be dropped silently.
  { vigenciadesde: "2021-02-01T00:00:00.000" }, // missing valor
  { valor: "0", vigenciadesde: "2021-02-02T00:00:00.000", vigenciahasta: "2021-02-02T00:00:00.000" }, // zero
  { valor: "not-a-number", vigenciadesde: "2021-02-03T00:00:00.000", vigenciahasta: "2021-02-03T00:00:00.000" },
  { valor: "3500.00" }, // missing vigenciadesde
];

describe("BanrepSource", () => {
  it("urlFor builds the Socrata SODA2 query with encoded $where and $order", () => {
    const src = new BanrepSource();
    const url = src.urlFor("2021-01-01", "2021-12-31");
    expect(url).toContain("https://www.datos.gov.co/resource/32sa-8pi3.json");
    expect(url).toContain("$where=");
    expect(url).toContain("vigenciadesde");
    expect(url).toContain("2021-01-01");
    expect(url).toContain("2021-12-31");
    expect(url).toContain("$order=");
    expect(url).toContain("$limit=50000");
  });

  it("urlFor rejects malformed or inverted ranges", () => {
    const src = new BanrepSource();
    expect(() => src.urlFor("2021-1-1", "2021-12-31")).toThrow(/Invalid BANREP range/);
    expect(() => src.urlFor("2021-12-31", "2021-01-01")).toThrow(/Invalid BANREP range/);
    expect(() => src.urlFor("not-a-date", "2021-12-31")).toThrow(/Invalid BANREP range/);
  });

  it("parse expands the Friday-covers-weekend interval into per-day rows", () => {
    const src = new BanrepSource();
    const rows = src.parse(FIXTURE, "2021-01-01", "2021-01-15");
    // Dec 31 row is clamped: 2021-01-01..2021-01-04 inside the window
    // (Dec 31 itself is before `from`). Single-day rows on 01-05/01-06.
    // Friday-to-Monday row expands 01-08..01-11.
    // Order is ascending.
    expect(rows.map((r) => r.date)).toEqual([
      "2021-01-01",
      "2021-01-02",
      "2021-01-03",
      "2021-01-04",
      "2021-01-05",
      "2021-01-06",
      "2021-01-08",
      "2021-01-09",
      "2021-01-10",
      "2021-01-11",
    ]);
    expect(rows[0]).toEqual({ date: "2021-01-01", value: 3432.5 });
    expect(rows[3]).toEqual({ date: "2021-01-04", value: 3432.5 });
    expect(rows[4]).toEqual({ date: "2021-01-05", value: 3420.78 });
  });

  it("parse drops bad rows silently (missing valor, zero, non-numeric, missing date)", () => {
    const src = new BanrepSource();
    const rows = src.parse(FIXTURE, "2021-02-01", "2021-02-28");
    // All four February rows in FIXTURE are garbage — expect zero output.
    expect(rows).toEqual([]);
  });

  it("parse coerces string `valor` values to numbers (Socrata returns strings in prod)", () => {
    const src = new BanrepSource();
    const rows = src.parse(FIXTURE, "2021-01-05", "2021-01-06");
    expect(rows).toHaveLength(2);
    expect(typeof rows[0]!.value).toBe("number");
    expect(rows[0]!.value).toBeCloseTo(3420.78, 6);
  });

  it("parse clamps the expanded interval to [from, to]", () => {
    const src = new BanrepSource();
    // Narrow window covers only the middle of the Friday-to-Monday row.
    const rows = src.parse(FIXTURE, "2021-01-09", "2021-01-10");
    expect(rows.map((r) => r.date)).toEqual(["2021-01-09", "2021-01-10"]);
    expect(rows.every((r) => r.value === 3478.11)).toBe(true);
  });

  it("parse dedupes overlapping intervals (latest wins)", () => {
    const src = new BanrepSource();
    // Synthesize a SuperFin correction: two rows both claiming 2021-01-08.
    const raw: BanrepRawObservation[] = [
      {
        valor: "3478.11",
        vigenciadesde: "2021-01-08T00:00:00.000",
        vigenciahasta: "2021-01-08T00:00:00.000",
      },
      {
        valor: "3499.99",
        vigenciadesde: "2021-01-08T00:00:00.000",
        vigenciahasta: "2021-01-08T00:00:00.000",
      },
    ];
    const rows = src.parse(raw, "2021-01-01", "2021-01-31");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(3499.99);
  });

  it("toInserts emits USD/COP rows tagged with source_authority='BANREP'", () => {
    const src = new BanrepSource();
    const rows = src.toInserts(FIXTURE, "2026-05-27T00:00:00.000Z", {
      from: "2021-01-05",
      to: "2021-01-05",
    });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.source_currency).toBe("USD");
    expect(r.target_currency).toBe("COP");
    expect(r.bucket_ts).toBe("2021-01-05T00:00:00.000Z");
    // datos.gov.co publishes COP per 1 USD — matches ORBI USD-base, no inversion.
    expect(r.rate).toBeCloseTo(3420.78, 6);
    expect(r.source_authority).toBe("BANREP");
    expect(r.product).toBe("ORBI-D-authority");
    expect(r.tier).toBe("B-single");
    expect(r.granularity).toBe("1d");
    expect(r.provider_count).toBe(1);
    expect(r.provenance).toBe("historical-backfill");
    expect(r.status).toBe("CONFIRMED");
    expect(r.composite).toBe(false);
  });

  it("toInserts handles empty input gracefully", () => {
    const src = new BanrepSource();
    expect(
      src.toInserts([], "2026-05-27T00:00:00.000Z", { from: "2021-01-01", to: "2021-12-31" }),
    ).toEqual([]);
  });

  it("fetch propagates non-200 with status + body slice", async () => {
    const src = new BanrepSource();
    const fetchImpl = async () => new Response("nope", { status: 503 });
    await expect(
      src.fetch({
        from: "2021-01-01",
        to: "2021-12-31",
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toThrow(/BANREP\/datos\.gov\.co 503/);
  });

  it("fetch rejects non-array JSON responses", async () => {
    const src = new BanrepSource();
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "blocked" }), { status: 200 });
    await expect(
      src.fetch({
        from: "2021-01-01",
        to: "2021-12-31",
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toThrow(/expected JSON array/);
  });

  it("fetchRange widens the upstream query by 7 days on the leading edge", async () => {
    const src = new BanrepSource();
    const captured: string[] = [];
    const fetchImpl = (async (url: string) => {
      captured.push(url);
      // Echo back a single row that starts before `from` but spans into it.
      const body: BanrepRawObservation[] = [
        {
          valor: "3432.5",
          vigenciadesde: "2020-12-31T00:00:00.000",
          vigenciahasta: "2021-01-04T00:00:00.000",
        },
      ];
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const parsed = await src.fetchRange({
      from: "2021-01-01",
      to: "2021-01-05",
      fetchImpl,
    });
    // Look-back applied: 2021-01-01 minus 7 days = 2020-12-25.
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("2020-12-25");
    // Output is clamped back to [from, to] and expanded.
    expect(parsed.map((r) => r.date)).toEqual([
      "2021-01-01",
      "2021-01-02",
      "2021-01-03",
      "2021-01-04",
    ]);
  });

  it("fetchRange rejects malformed or inverted ranges", async () => {
    const src = new BanrepSource();
    await expect(
      src.fetchRange({ from: "2021-12-31", to: "2021-01-01" }),
    ).rejects.toThrow(/Invalid BANREP range/);
    await expect(
      src.fetchRange({ from: "not-a-date", to: "2021-12-31" }),
    ).rejects.toThrow(/Invalid BANREP range/);
  });
});

describe("BANREP date helpers", () => {
  it("isoDateOnly extracts the YYYY-MM-DD prefix", () => {
    expect(isoDateOnly("2026-05-27T00:00:00.000")).toBe("2026-05-27");
    expect(isoDateOnly("2026-05-27")).toBe("2026-05-27");
    expect(isoDateOnly("garbage")).toBeNull();
  });

  it("iterateDays yields each date inclusive, UTC-safe", () => {
    expect([...iterateDays("2024-02-28", "2024-03-02")]).toEqual([
      "2024-02-28",
      "2024-02-29", // 2024 is a leap year
      "2024-03-01",
      "2024-03-02",
    ]);
  });

  it("iterateDays yields nothing for an inverted range", () => {
    expect([...iterateDays("2024-03-02", "2024-02-28")]).toEqual([]);
  });

  it("shiftIsoDay handles month/year rollover", () => {
    expect(shiftIsoDay("2021-01-01", -7)).toBe("2020-12-25");
    expect(shiftIsoDay("2024-02-28", 1)).toBe("2024-02-29");
    expect(shiftIsoDay("2023-02-28", 1)).toBe("2023-03-01");
  });
});
