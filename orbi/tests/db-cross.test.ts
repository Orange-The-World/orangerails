/**
 * Tests for DbCrossRateSource. Mocks Bun.SQL by passing a stub object with a
 * tagged-template callable surface that records the call and returns a
 * pre-baked row.
 */

import { describe, expect, it } from "bun:test";
import { DbCrossRateSource } from "../src/sources/db-cross.ts";
import { resolveComposite } from "../src/calculate/resolve-composite.ts";
import type { Source } from "../src/sources/interface.ts";
import type { Candle, SourceResponse } from "../src/sources/types.ts";

interface Row {
  bucket_ts: Date;
  rate: number;
  source_authority: string;
}

function makeSqlStub(rows: Row[]) {
  const tag = ((strings: TemplateStringsArray, ..._vals: unknown[]) => {
    return Promise.resolve(rows);
  }) as unknown as ConstructorParameters<typeof DbCrossRateSource>[0];
  return tag;
}

describe("DbCrossRateSource", () => {
  it("returns the latest USD/X candle when authority + freshness pass", async () => {
    const bucket = new Date("2026-06-08T00:00:00Z");
    const sql = makeSqlStub([
      { bucket_ts: bucket, rate: 129.34, source_authority: "OXR" },
    ]);
    const src = new DbCrossRateSource(sql, [
      { target: "KES", authorities: ["OXR"], freshnessMs: 26 * 60 * 60 * 1000 },
    ]);
    // effectiveAt = 6 hours after the bucket — well inside 26h freshness.
    const effectiveAt = new Date("2026-06-08T06:00:00Z");
    const resp = await src.fetch({ source: "USD", target: "KES" }, effectiveAt, effectiveAt);
    expect(resp.success).toBe(true);
    expect(resp.candles.length).toBe(1);
    expect(resp.candles[0]!.close).toBe(129.34);
    expect(resp.source).toBe("db-cross:OXR");
  });

  it("fails (SKIP path) when the latest row is stale beyond freshnessMs", async () => {
    const bucket = new Date("2026-06-01T00:00:00Z");
    const sql = makeSqlStub([
      { bucket_ts: bucket, rate: 31.5, source_authority: "OXR" },
    ]);
    const src = new DbCrossRateSource(sql, [
      // freshness = 26h
      { target: "TWD", authorities: ["OXR"], freshnessMs: 26 * 60 * 60 * 1000 },
    ]);
    const effectiveAt = new Date("2026-06-08T00:00:00Z"); // 7 days later
    const resp = await src.fetch({ source: "USD", target: "TWD" }, effectiveAt, effectiveAt);
    expect(resp.success).toBe(false);
    expect(resp.errorMessage).toContain("stale");
  });

  it("fails when target is not in the allowlist", async () => {
    const sql = makeSqlStub([]);
    const src = new DbCrossRateSource(sql, [
      { target: "KES", authorities: ["OXR"], freshnessMs: 26 * 60 * 60 * 1000 },
    ]);
    const effectiveAt = new Date("2026-06-08T00:00:00Z");
    const resp = await src.fetch({ source: "USD", target: "XYZ" }, effectiveAt, effectiveAt);
    expect(resp.success).toBe(false);
    expect(resp.errorMessage).toContain("not configured");
  });

  it("fails when source != USD", async () => {
    const sql = makeSqlStub([]);
    const src = new DbCrossRateSource(sql, [
      { target: "KES", authorities: ["OXR"], freshnessMs: 26 * 60 * 60 * 1000 },
    ]);
    const effectiveAt = new Date("2026-06-08T00:00:00Z");
    const resp = await src.fetch({ source: "EUR", target: "KES" }, effectiveAt, effectiveAt);
    expect(resp.success).toBe(false);
    expect(resp.errorMessage).toContain("USD source");
  });

  it("fails when no row is returned", async () => {
    const sql = makeSqlStub([]);
    const src = new DbCrossRateSource(sql, [
      { target: "KES", authorities: ["OXR"], freshnessMs: 26 * 60 * 60 * 1000 },
    ]);
    const effectiveAt = new Date("2026-06-08T00:00:00Z");
    const resp = await src.fetch({ source: "USD", target: "KES" }, effectiveAt, effectiveAt);
    expect(resp.success).toBe(false);
    expect(resp.errorMessage).toContain("no USD/KES row found");
  });
});

describe("resolveComposite with DbCrossRateSource (end-to-end)", () => {
  it("multiplies BTC/USD × USD/KES from the DB cross-rate source", async () => {
    // Stub BTC source: returns a candle at the target minute.
    const targetBucket = new Date("2026-06-08T12:00:00Z"); // partitionBucketTs of 12:01:00
    const btcSource: Source = {
      name: "stub-btc",
      role: "primary",
      pairsSupported: ["BTC-USD"],
      rateLimitRps: 1,
      userAgent: "stub",
      async fetch(): Promise<SourceResponse> {
        const candle: Candle = {
          bucketTs: targetBucket,
          open: 100_000,
          high: 100_500,
          low: 99_500,
          close: 100_000,
          volume: 5,
        };
        return {
          source: "stub-btc",
          candles: [candle],
          success: true,
          fetchedAt: new Date(),
        };
      },
      async healthCheck() {
        return { name: "stub-btc", reachable: true };
      },
    };
    const sql = makeSqlStub([
      { bucket_ts: new Date("2026-06-08T00:00:00Z"), rate: 129.34, source_authority: "OXR" },
    ]);
    const dbCross = new DbCrossRateSource(sql, [
      { target: "KES", authorities: ["OXR"], freshnessMs: 26 * 60 * 60 * 1000 },
    ]);

    const effectiveAt = new Date("2026-06-08T12:01:00Z");
    const result = await resolveComposite({
      pair: { source: "BTC", target: "KES" },
      effectiveAt,
      btcSources: [btcSource],
      crossRateSource: dbCross,
    });

    expect(result.crossRate).toBe(129.34);
    expect(result.rate).toBeCloseTo(100_000 * 129.34, 2);
    expect(result.tier).toBe("C-composite");
    expect(result.audit.crossRateSource).toBe("db-cross");
  });
});
