import { describe, expect, it } from "vitest";
import {
  SarbSource,
  type SarbRawObservation,
} from "../../scripts/central-banks/sources/sarb";

/**
 * Synthetic SARB Web API responses. Real responses arrive newest-first
 * (matching the live custom.resbank.co.za behaviour observed on
 * 2026-05-27); the parser must sort ascending and drop malformed rows
 * before the orchestrator inserts them.
 */
const FIXTURE_NEWEST_FIRST: SarbRawObservation[] = [
  {
    Period: "2026-05-27T00:00:00",
    Timeseries: "Rand per US Dollar",
    Description: "Weighted average ...",
    Value: 16.3551,
    FormatNumber: "0.0000",
    FormatDate: "yyyy-MM-dd",
  },
  {
    Period: "2026-05-26T00:00:00",
    Timeseries: "Rand per US Dollar",
    Description: "Weighted average ...",
    Value: 16.3474,
  },
  {
    Period: "2026-05-25T00:00:00",
    Timeseries: "Rand per US Dollar",
    Description: "Weighted average ...",
    Value: 16.3350,
  },
];

describe("SarbSource.urlFor", () => {
  it("builds the documented GetTimeseriesObservations path", () => {
    const src = new SarbSource();
    expect(src.urlFor("2021-01-01", "2026-05-27")).toBe(
      "https://custom.resbank.co.za/SarbWebApi/WebIndicators/Shared/GetTimeseriesObservations/EXCX135D/2021-01-01/2026-05-27",
    );
  });

  it("rejects malformed dates", () => {
    const src = new SarbSource();
    expect(() => src.urlFor("2021-1-1", "2026-05-27")).toThrow();
    expect(() => src.urlFor("not-a-date", "2026-05-27")).toThrow();
  });

  it("rejects inverted ranges", () => {
    const src = new SarbSource();
    expect(() => src.urlFor("2026-05-27", "2021-01-01")).toThrow(
      /inverted/,
    );
  });
});

describe("SarbSource.parse", () => {
  it("sorts ascending and preserves valid observations", () => {
    const src = new SarbSource();
    const out = src.parse(FIXTURE_NEWEST_FIRST);
    expect(out.map((r) => r.date)).toEqual([
      "2026-05-25",
      "2026-05-26",
      "2026-05-27",
    ]);
    expect(out[2]!.value).toBeCloseTo(16.3551, 6);
  });

  it("drops malformed / zero / negative observations silently", () => {
    const src = new SarbSource();
    const out = src.parse([
      { Period: "2026-05-27T00:00:00", Value: 16.3551 },
      { Period: "garbage", Value: 16.0 },
      { Period: "2026-05-26T00:00:00", Value: 0 }, // zero
      { Period: "2026-05-25T00:00:00", Value: -1 }, // negative
      { Period: "2026-05-24T00:00:00" }, // missing value
      { Value: 16.0 }, // missing period
      { Period: "2026-05-23T00:00:00", Value: Number.NaN },
    ]);
    expect(out.map((r) => r.date)).toEqual(["2026-05-27"]);
  });

  it("ignores extra fields and is robust to missing optional fields", () => {
    const src = new SarbSource();
    const out = src.parse([
      { Period: "2024-12-31T00:00:00", Value: 18.7 } as SarbRawObservation,
    ]);
    expect(out).toEqual([{ date: "2024-12-31", value: 18.7 }]);
  });
});

describe("SarbSource.toInserts", () => {
  it("maps parsed rows to USD/ZAR authority inserts", () => {
    const src = new SarbSource();
    const rows = src.parse(FIXTURE_NEWEST_FIRST);
    const inserts = src.toInserts(rows, "2026-05-27T12:00:00.000Z");
    expect(inserts).toHaveLength(3);
    const first = inserts[0]!;
    expect(first.source_currency).toBe("USD");
    expect(first.target_currency).toBe("ZAR");
    expect(first.source_authority).toBe("SARB");
    expect(first.granularity).toBe("1d");
    expect(first.product).toBe("ORBI-D-authority");
    expect(first.tier).toBe("B-single");
    expect(first.composite).toBe(false);
    expect(first.provider_count).toBe(1);
    expect(first.status).toBe("CONFIRMED");
    expect(first.bucket_ts).toBe("2026-05-25T00:00:00.000Z");
    expect(first.rate).toBeCloseTo(16.335, 6);
    expect(first.fetched_at).toBe("2026-05-27T12:00:00.000Z");
    expect(first.computed_at).toBe("2026-05-27T12:00:00.000Z");
    expect(first.provenance).toBe("historical-backfill");
  });

  it("filters non-finite / non-positive rates defensively", () => {
    const src = new SarbSource();
    const inserts = src.toInserts(
      [
        { date: "2026-05-27", value: 16.3551 },
        { date: "2026-05-26", value: 0 },
        { date: "2026-05-25", value: Number.NaN },
        { date: "2026-05-24", value: -1 },
      ],
      "2026-05-27T12:00:00.000Z",
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.bucket_ts).toBe("2026-05-27T00:00:00.000Z");
  });
});

describe("SarbSource.fetch / fetchRange", () => {
  it("propagates HTTP errors from the SARB Web API", async () => {
    const src = new SarbSource();
    const fakeFetch = (async () =>
      new Response("upstream error", { status: 503 })) as unknown as typeof fetch;
    await expect(
      src.fetch({ from: "2021-01-01", to: "2026-05-27", fetchImpl: fakeFetch }),
    ).rejects.toThrow(/SARB 503/);
  });

  it("rejects a non-array JSON body", async () => {
    const src = new SarbSource();
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: "nope" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(
      src.fetch({ from: "2021-01-01", to: "2026-05-27", fetchImpl: fakeFetch }),
    ).rejects.toThrow(/expected JSON array/);
  });

  it("fetchRange filters to the [from, to] window and dedupes by date", async () => {
    const src = new SarbSource();
    const payload: SarbRawObservation[] = [
      { Period: "2026-05-27T00:00:00", Value: 16.3551 },
      { Period: "2026-05-27T00:00:00", Value: 16.3551 }, // duplicate
      { Period: "2026-05-26T00:00:00", Value: 16.3474 },
      { Period: "2020-12-31T00:00:00", Value: 14.6 }, // out of range
    ];
    const fakeFetch = (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const rows = await src.fetchRange({
      from: "2021-01-01",
      to: "2026-05-27",
      fetchImpl: fakeFetch,
    });
    expect(rows.map((r) => r.date)).toEqual(["2026-05-26", "2026-05-27"]);
  });
});
