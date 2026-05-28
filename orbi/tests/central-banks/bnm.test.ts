import { describe, expect, it } from "vitest";
import {
  BnmSource,
  computeMid,
  extractRateBlocks,
  parseYM,
  type BnmParsedRow,
  type BnmRawResponse,
} from "../../scripts/central-banks/sources/bnm";

describe("BnmSource utilities", () => {
  it("parseYM extracts year/month from YYYY-MM-DD", () => {
    expect(parseYM("2024-01-15")).toEqual([2024, 1]);
    expect(parseYM("2021-12-31")).toEqual([2021, 12]);
  });

  it("parseYM rejects malformed dates", () => {
    expect(() => parseYM("2024/01/15")).toThrow();
    expect(() => parseYM("01-2024-15")).toThrow();
    expect(() => parseYM("")).toThrow();
  });

  it("computeMid prefers middle_rate when populated", () => {
    expect(
      computeMid({ buying_rate: 4.0, selling_rate: 5.0, middle_rate: 4.5 }),
    ).toBe(4.5);
  });

  it("computeMid falls back to (buying+selling)/2 when middle_rate is null", () => {
    expect(
      computeMid({ buying_rate: 4.63, selling_rate: 4.655, middle_rate: null }),
    ).toBeCloseTo(4.6425, 6);
  });

  it("computeMid returns null when both sides are missing", () => {
    expect(
      computeMid({
        buying_rate: null,
        selling_rate: null,
        middle_rate: null,
      }),
    ).toBeNull();
    expect(computeMid({})).toBeNull();
  });

  it("computeMid rejects zero / negative buying or selling", () => {
    expect(
      computeMid({ buying_rate: 0, selling_rate: 4.6, middle_rate: null }),
    ).toBeNull();
    expect(
      computeMid({ buying_rate: 4.6, selling_rate: -1, middle_rate: null }),
    ).toBeNull();
  });
});

describe("extractRateBlocks", () => {
  it("handles single-date payload (data.rate as object)", () => {
    const raw: BnmRawResponse = {
      data: {
        currency_code: "USD",
        unit: 1,
        rate: {
          date: "2024-01-15",
          buying_rate: 4.63,
          selling_rate: 4.655,
          middle_rate: null,
        },
      },
    };
    const blocks = extractRateBlocks(raw);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.date).toBe("2024-01-15");
  });

  it("handles month-window payload (data.rate as array)", () => {
    const raw: BnmRawResponse = {
      data: {
        currency_code: "USD",
        unit: 1,
        rate: [
          {
            date: "2024-01-02",
            buying_rate: 4.576,
            selling_rate: 4.601,
            middle_rate: null,
          },
          {
            date: "2024-01-03",
            buying_rate: 4.6,
            selling_rate: 4.625,
            middle_rate: null,
          },
        ],
      },
    };
    const blocks = extractRateBlocks(raw);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.date)).toEqual(["2024-01-02", "2024-01-03"]);
  });

  it("returns [] for empty data", () => {
    expect(extractRateBlocks({})).toEqual([]);
    expect(extractRateBlocks({ data: undefined })).toEqual([]);
  });
});

describe("BnmSource.parse", () => {
  it("returns ascending [{date, rate}] from a month payload", () => {
    const src = new BnmSource();
    const raw: BnmRawResponse = {
      data: {
        currency_code: "USD",
        unit: 1,
        rate: [
          {
            date: "2024-01-03",
            buying_rate: 4.6,
            selling_rate: 4.625,
            middle_rate: null,
          },
          {
            date: "2024-01-02",
            buying_rate: 4.576,
            selling_rate: 4.601,
            middle_rate: null,
          },
        ],
      },
    };
    const rows = src.parse(raw);
    expect(rows.map((r) => r.date)).toEqual(["2024-01-02", "2024-01-03"]);
    expect(rows[0]!.rate).toBeCloseTo((4.576 + 4.601) / 2, 6);
    expect(rows[1]!.rate).toBeCloseTo((4.6 + 4.625) / 2, 6);
  });

  it("drops observations with no usable rate block", () => {
    const src = new BnmSource();
    const raw: BnmRawResponse = {
      data: {
        currency_code: "USD",
        unit: 1,
        rate: [
          {
            date: "2024-01-02",
            buying_rate: 4.576,
            selling_rate: 4.601,
            middle_rate: null,
          },
          {
            date: "2024-01-03",
            buying_rate: null,
            selling_rate: null,
            middle_rate: null,
          },
        ],
      },
    };
    const rows = src.parse(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.date).toBe("2024-01-02");
  });
});

describe("BnmSource.toInserts", () => {
  it("emits USD/MYR rows tagged with source_authority='BNM'", () => {
    const src = new BnmSource();
    const parsed: BnmParsedRow[] = [
      { date: "2024-01-02", rate: 4.5885 },
      { date: "2024-01-03", rate: 4.6125 },
    ];
    const rows = src.toInserts(parsed, "2026-05-27T00:00:00.000Z");
    expect(rows).toHaveLength(2);
    const first = rows[0]!;
    expect(first.source_currency).toBe("USD");
    expect(first.target_currency).toBe("MYR");
    expect(first.bucket_ts).toBe("2024-01-02T00:00:00.000Z");
    expect(first.rate).toBeCloseTo(4.5885, 6);
    expect(first.source_authority).toBe("BNM");
    expect(first.product).toBe("ORBI-D-authority");
    expect(first.tier).toBe("B-single");
    expect(first.granularity).toBe("1d");
    expect(first.provider_count).toBe(1);
    expect(first.provenance).toBe("historical-backfill");
    expect(first.status).toBe("CONFIRMED");
    expect(first.composite).toBe(false);
  });

  it("drops non-finite and non-positive rates", () => {
    const src = new BnmSource();
    const parsed: BnmParsedRow[] = [
      { date: "2024-01-02", rate: Number.NaN },
      { date: "2024-01-03", rate: 0 },
      { date: "2024-01-04", rate: -4.6 },
      { date: "2024-01-05", rate: 4.65 },
    ];
    const rows = src.toInserts(parsed, "2026-05-27T00:00:00.000Z");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bucket_ts).toBe("2024-01-05T00:00:00.000Z");
  });
});

describe("BnmSource.fetchMonth", () => {
  it("propagates non-200 with status + body slice", async () => {
    const src = new BnmSource();
    const fetchImpl = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(
      src.fetchMonth({ year: 2024, month: 1, fetchImpl }),
    ).rejects.toThrow(/BNM 503/);
  });

  it("hits the documented Kijang URL with the vendor Accept header", async () => {
    const src = new BnmSource();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ data: { currency_code: "USD", unit: 1, rate: [] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    await src.fetchMonth({ year: 2024, month: 1, fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://api.bnm.gov.my/public/exchange-rate/USD/year/2024/month/1",
    );
    const headers = (calls[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers["Accept"]).toBe("application/vnd.BNM.API.v1+json");
    expect(headers["User-Agent"]).toMatch(/Orange-Rails-ORBI/);
  });

  it("rejects out-of-range year/month", () => {
    const src = new BnmSource();
    expect(() => src.urlForMonth(1999, 1)).toThrow();
    expect(() => src.urlForMonth(2024, 0)).toThrow();
    expect(() => src.urlForMonth(2024, 13)).toThrow();
  });
});

describe("BnmSource.fetchRange", () => {
  it("dedupes by date when adjacent months overlap (boundary timezone bug)", async () => {
    const src = new BnmSource();
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      // Month 1 returns an entry for 2024-02-01 (cross-month leakage).
      // Month 2 also returns 2024-02-01 with a slightly different rate.
      // Dedup must keep one row only; last-write-wins.
      if (call === 1) {
        return new Response(
          JSON.stringify({
            data: {
              currency_code: "USD",
              unit: 1,
              rate: [
                {
                  date: "2024-01-31",
                  buying_rate: 4.7,
                  selling_rate: 4.72,
                  middle_rate: null,
                },
                {
                  date: "2024-02-01",
                  buying_rate: 4.71,
                  selling_rate: 4.73,
                  middle_rate: null,
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            currency_code: "USD",
            unit: 1,
            rate: [
              {
                date: "2024-02-01",
                buying_rate: 4.712,
                selling_rate: 4.732,
                middle_rate: null,
              },
              {
                date: "2024-02-02",
                buying_rate: 4.72,
                selling_rate: 4.74,
                middle_rate: null,
              },
            ],
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const rows = await src.fetchRange({
      from: "2024-01-01",
      to: "2024-02-29",
      fetchImpl,
      sleep: async () => {},
    });
    expect(rows.map((r) => r.date)).toEqual([
      "2024-01-31",
      "2024-02-01",
      "2024-02-02",
    ]);
    const feb1 = rows.find((r) => r.date === "2024-02-01")!;
    expect(feb1.rate).toBeCloseTo((4.712 + 4.732) / 2, 6);
  });

  it("respects the [from, to] window across multi-month walk", async () => {
    const src = new BnmSource();
    const fetchImpl = (async (url: string) => {
      const m = url.match(/month\/(\d+)$/);
      const month = Number(m?.[1] ?? "0");
      const dateIso = `2024-${String(month).padStart(2, "0")}-15`;
      return new Response(
        JSON.stringify({
          data: {
            currency_code: "USD",
            unit: 1,
            rate: {
              date: dateIso,
              buying_rate: 4.6,
              selling_rate: 4.65,
              middle_rate: null,
            },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const rows = await src.fetchRange({
      from: "2024-01-20",
      to: "2024-02-28",
      fetchImpl,
      sleep: async () => {},
    });
    // Jan 15 is before `from`; only Feb 15 should remain.
    expect(rows.map((r) => r.date)).toEqual(["2024-02-15"]);
  });
});
