/**
 * BatchWriter unit tests — chunking, idempotent UPSERT, retry-on-transient.
 *
 * Mocks the SQL executor so we never hit Supabase. Asserts the SQL itself
 * (it's a UPSERT, has provenance, matches our chunk size) and the retry +
 * give-up policy for transient and permanent errors.
 */

import { describe, expect, it, vi } from "vitest";
import {
  BatchWriter,
  buildUpsertSql,
  type ExchangeRateInsert,
} from "../../scripts/historical-backfill/lib/batch-writer";

function makeRow(bucketSec: number, rate: number): ExchangeRateInsert {
  const iso = new Date(bucketSec * 1000).toISOString();
  return {
    source_currency: "BTC",
    target_currency: "USD",
    bucket_ts: iso,
    granularity: "1m",
    product: "ORBI-M",
    rate,
    tier: "B-single",
    composite: false,
    composite_via: null,
    provider_count: 1,
    status: "CONFIRMED",
    fetched_at: iso,
    computed_at: iso,
  };
}

describe("buildUpsertSql", () => {
  it("includes ON CONFLICT … DO UPDATE clause", () => {
    const sql = buildUpsertSql([makeRow(1622011380, 40000)], "historical-backfill");
    expect(sql).toMatch(/ON CONFLICT/);
    expect(sql).toMatch(/DO UPDATE SET/);
    expect(sql).toMatch(/RETURNING id/);
  });

  it("tags every row with the provenance argument", () => {
    const sql = buildUpsertSql([makeRow(1622011380, 40000)], "historical-backfill");
    expect(sql).toMatch(/'historical-backfill'/);
  });

  it("renders one VALUES tuple per row", () => {
    const sql = buildUpsertSql(
      [makeRow(1622011380, 40000), makeRow(1622011440, 40100), makeRow(1622011500, 40200)],
      "historical-backfill",
    );
    expect((sql.match(/\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(sql).toMatch(/40000/);
    expect(sql).toMatch(/40200/);
  });

  it("throws on empty rows", () => {
    expect(() => buildUpsertSql([], "historical-backfill")).toThrow();
  });
});

describe("BatchWriter.write", () => {
  it("chunks at the configured chunk size", async () => {
    const exec = vi.fn().mockResolvedValue([{ id: "x" }]);
    const writer = new BatchWriter({ exec }, { chunkSize: 100 });
    const rows = Array.from({ length: 250 }, (_, i) => makeRow(1622011380 + i * 60, 40000 + i));
    const res = await writer.write(rows);
    expect(res.written).toBe(250);
    expect(res.errors).toBe(0);
    expect(exec).toHaveBeenCalledTimes(3); // 100 + 100 + 50
  });

  it("retries transient failures and eventually succeeds", async () => {
    let calls = 0;
    const exec = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw new Error("HTTP 503 from supabase");
      return [{ id: "x" }];
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const writer = new BatchWriter({ exec, sleep }, { chunkSize: 10, backoffBaseMs: 1 });
    const rows = [makeRow(1622011380, 40000)];
    const res = await writer.write(rows);
    expect(res.written).toBe(1);
    expect(res.errors).toBe(0);
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("gives up after maxRetries and records error", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("HTTP 503 persistent"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const writer = new BatchWriter({ exec, sleep }, { chunkSize: 10, maxRetries: 2, backoffBaseMs: 1 });
    const rows = [makeRow(1622011380, 40000)];
    const res = await writer.write(rows);
    expect(res.written).toBe(0);
    expect(res.errors).toBe(1);
    expect(res.errorDetails[0]).toMatch(/503/);
    expect(exec).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("does NOT retry non-transient (4xx) errors", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("HTTP 400 bad request: invalid SQL"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const writer = new BatchWriter({ exec, sleep }, { chunkSize: 10, maxRetries: 4, backoffBaseMs: 1 });
    const rows = [makeRow(1622011380, 40000)];
    const res = await writer.write(rows);
    expect(res.errors).toBe(1);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
