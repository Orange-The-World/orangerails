import { describe, expect, it } from "vitest";
import {
  BcrpSource,
  BCRP_SERIES_INTERBANK_VENTA,
  isoDateOrNull,
  parseSpanishDayMonthYear,
  type BcrpRawResponse,
} from "../../scripts/central-banks/sources/bcrp";

/**
 * Synthetic BCRPData response shaped exactly like the live API, with
 * Spanish-month-name dates and decimal-string values. Includes a few
 * garbage rows to exercise the filter path.
 */
const FIXTURE: BcrpRawResponse = {
  config: {
    title: "Tipo de cambio",
    series: [
      {
        name: "Tipo de cambio - TC Interbancario (S/ por US$) - Venta",
        dec: "3",
      },
    ],
  },
  periods: [
    { name: "04.Ene.21", values: ["3.62666666666667"] },
    { name: "05.Ene.21", values: ["3.63366666666667"] },
    { name: "06.Ene.21", values: ["3.62683333333333"] },
    // Sep alt-abbrev defensive case.
    { name: "07.Sep.21", values: ["3.611"] },
    // BCRP-canonical "Set" abbreviation for September.
    { name: "08.Set.21", values: ["3.612"] },
    // Garbage value: non-numeric string.
    { name: "09.Set.21", values: ["n.a."] },
    // Garbage value: zero.
    { name: "10.Set.21", values: ["0"] },
    // Garbage value: negative.
    { name: "11.Set.21", values: ["-3.5"] },
    // Garbage: empty values array.
    { name: "12.Set.21", values: [] },
    // Garbage: missing values entirely.
    { name: "13.Set.21" },
    // Malformed period name.
    { name: "not-a-date", values: ["3.6"] },
    // Impossible date (Feb 30) — silently dropped.
    { name: "30.Feb.21", values: ["3.6"] },
    // Latest in window.
    { name: "23.May.25", values: ["3.6605"] },
  ],
};

describe("parseSpanishDayMonthYear", () => {
  it("parses BCRP's DD.MMM.YY format with two-digit year", () => {
    expect(parseSpanishDayMonthYear("04.Ene.21")).toBe("2021-01-04");
    expect(parseSpanishDayMonthYear("23.May.25")).toBe("2025-05-23");
    expect(parseSpanishDayMonthYear("31.Dic.24")).toBe("2024-12-31");
  });

  it("accepts both 'Set' (BCRP canonical) and 'Sep' for September", () => {
    expect(parseSpanishDayMonthYear("08.Set.21")).toBe("2021-09-08");
    expect(parseSpanishDayMonthYear("08.Sep.21")).toBe("2021-09-08");
  });

  it("handles 4-digit year defensively", () => {
    expect(parseSpanishDayMonthYear("04.Ene.2021")).toBe("2021-01-04");
  });

  it("returns null on malformed or impossible dates", () => {
    expect(parseSpanishDayMonthYear("not-a-date")).toBeNull();
    expect(parseSpanishDayMonthYear("30.Feb.21")).toBeNull();
    expect(parseSpanishDayMonthYear("01.Xyz.21")).toBeNull();
    expect(parseSpanishDayMonthYear("04/Ene/21")).toBeNull();
  });

  it("is case-insensitive on the month abbreviation", () => {
    expect(parseSpanishDayMonthYear("04.ENE.21")).toBe("2021-01-04");
    expect(parseSpanishDayMonthYear("04.ene.21")).toBe("2021-01-04");
  });
});

describe("isoDateOrNull", () => {
  it("accepts real dates", () => {
    expect(isoDateOrNull(2021, 1, 4)).toBe("2021-01-04");
    expect(isoDateOrNull(2024, 12, 31)).toBe("2024-12-31");
  });
  it("rejects impossible dates", () => {
    expect(isoDateOrNull(2021, 2, 30)).toBeNull();
    expect(isoDateOrNull(2021, 13, 1)).toBeNull();
    expect(isoDateOrNull(2021, 4, 31)).toBeNull();
  });
});

describe("BcrpSource", () => {
  it("exposes the canonical interbank series code", () => {
    expect(BCRP_SERIES_INTERBANK_VENTA).toBe("PD04638PD");
  });

  it("urlFor builds the BCRPData series JSON endpoint", () => {
    const src = new BcrpSource();
    expect(src.urlFor("PD04638PD", "2021-01-01", "2025-05-23")).toBe(
      "https://estadisticas.bcrp.gob.pe/estadisticas/series/api/PD04638PD/json/2021-01-01/2025-05-23",
    );
  });

  it("urlFor rejects malformed series codes and dates", () => {
    const src = new BcrpSource();
    expect(() => src.urlFor("bad code", "2021-01-01", "2025-05-23")).toThrow(/Invalid BCRP series/);
    expect(() => src.urlFor("PD04638PD", "2021/01/01", "2025-05-23")).toThrow(/YYYY-MM-DD/);
    expect(() => src.urlFor("PD04638PD", "2025-05-23", "2021-01-01")).toThrow(/Invalid BCRP range/);
  });

  it("parse sorts ascending and drops bad / no-data observations", () => {
    const src = new BcrpSource();
    const rows = src.parse(FIXTURE);
    expect(rows.map((r) => r.date)).toEqual([
      "2021-01-04",
      "2021-01-05",
      "2021-01-06",
      "2021-09-07",
      "2021-09-08",
      "2025-05-23",
    ]);
    expect(rows[0]!.value).toBeCloseTo(3.62666666666667, 10);
    expect(rows[rows.length - 1]!.value).toBeCloseTo(3.6605, 6);
  });

  it("toInserts emits USD/PEN rows tagged with source_authority='BCRP'", () => {
    const src = new BcrpSource();
    const rows = src.toInserts(FIXTURE, "2026-05-27T00:00:00.000Z");
    expect(rows).toHaveLength(6);
    const first = rows[0]!;
    expect(first.source_currency).toBe("USD");
    expect(first.target_currency).toBe("PEN");
    expect(first.bucket_ts).toBe("2021-01-04T00:00:00.000Z");
    // BCRP publishes PEN per 1 USD — matches ORBI USD-base, no inversion.
    expect(first.rate).toBeCloseTo(3.62666666666667, 10);
    expect(first.source_authority).toBe("BCRP");
    expect(first.product).toBe("ORBI-D-authority");
    expect(first.tier).toBe("B-single");
    expect(first.granularity).toBe("1d");
    expect(first.provider_count).toBe(1);
    expect(first.provenance).toBe("historical-backfill");
    expect(first.status).toBe("CONFIRMED");
    expect(first.composite).toBe(false);
  });

  it("toInserts respects [from, to] bounds defensively", () => {
    const src = new BcrpSource();
    const rows = src.toInserts(FIXTURE, "2026-05-27T00:00:00.000Z", {
      from: "2021-09-01",
      to: "2021-12-31",
    });
    expect(rows.map((r) => r.bucket_ts)).toEqual([
      "2021-09-07T00:00:00.000Z",
      "2021-09-08T00:00:00.000Z",
    ]);
  });

  it("toInserts handles empty / missing periods gracefully", () => {
    const src = new BcrpSource();
    expect(src.toInserts({}, "2026-05-27T00:00:00.000Z")).toEqual([]);
    expect(src.toInserts({ periods: [] }, "2026-05-27T00:00:00.000Z")).toEqual([]);
  });

  it("fetch propagates non-200 with status + body slice", async () => {
    const src = new BcrpSource();
    const fetchImpl = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(
      src.fetch({ from: "2021-01-01", to: "2021-01-31", fetchImpl }),
    ).rejects.toThrow(/BCRP 503/);
  });

  it("fetch hits the canonical PD04638PD endpoint with a polite UA", async () => {
    const src = new BcrpSource();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(FIXTURE), { status: 200 });
    }) as unknown as typeof fetch;
    await src.fetch({ from: "2021-01-01", to: "2025-05-23", fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://estadisticas.bcrp.gob.pe/estadisticas/series/api/PD04638PD/json/2021-01-01/2025-05-23",
    );
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/Orange-Rails-ORBI/);
    expect(headers["Accept"]).toMatch(/json/);
  });

  it("fetchRange dedups by date and filters to the window", async () => {
    const src = new BcrpSource();
    const dupResponse: BcrpRawResponse = {
      periods: [
        { name: "04.Ene.21", values: ["3.626"] },
        { name: "04.Ene.21", values: ["3.626"] }, // exact dup
        { name: "05.Ene.21", values: ["3.633"] },
        { name: "10.Dic.20", values: ["3.6"] }, // out-of-window: must drop
      ],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(dupResponse), { status: 200 })) as unknown as typeof fetch;
    const rows = await src.fetchRange({
      from: "2021-01-01",
      to: "2021-12-31",
      fetchImpl,
    });
    expect(rows.map((r) => r.date)).toEqual(["2021-01-04", "2021-01-05"]);
  });
});
