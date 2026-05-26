/**
 * Resolve orchestrator tests — verifies the end-to-end pipeline with mocked
 * sources. Confirms the audit row structure, tier classification, partition
 * math, and graceful failure containment.
 */

import { describe, expect, it } from "vitest";
import { resolve, partitionBucketTs, type ResolveRequest } from "../src/calculate/resolve";
import type { Source } from "../src/sources/interface";
import type { Candle, HealthStatus, Pair, SourceResponse } from "../src/sources/types";

/**
 * MockSource — returns a single candle keyed to the target bucket.
 * `behavior: 'success' | 'fail' | 'zero-volume' | 'wrong-bucket'`
 */
class MockSource implements Source {
  readonly role = "primary" as const;
  readonly pairsSupported = ["BTC-USD"];
  readonly rateLimitRps = 10;
  readonly userAgent = "test";

  constructor(
    readonly name: string,
    private readonly close: number,
    private readonly volume: number,
    private readonly behavior: "success" | "fail" | "zero-volume" | "wrong-bucket" = "success",
  ) {}

  async fetch(_pair: Pair, _from: Date, to: Date): Promise<SourceResponse> {
    if (this.behavior === "fail") {
      return {
        source: this.name,
        candles: [],
        success: false,
        errorMessage: "simulated network failure",
        fetchedAt: new Date(),
      };
    }
    const bucketTs = this.behavior === "wrong-bucket"
      ? new Date(to.getTime() - 5 * 60_000) // 5 minutes off
      : new Date(to.getTime() - 60_000);    // standard: bucket ends at `to`
    const candle: Candle = {
      bucketTs,
      open: this.close,
      high: this.close,
      low: this.close,
      close: this.close,
      volume: this.behavior === "zero-volume" ? 0 : this.volume,
    };
    return {
      source: this.name,
      candles: [candle],
      success: true,
      fetchedAt: new Date(),
    };
  }

  async healthCheck(): Promise<HealthStatus> {
    return { name: this.name, reachable: true, lastSuccessAt: new Date() };
  }
}

const EFFECTIVE_AT = new Date("2026-03-14T14:35:21Z");
const EXPECTED_BUCKET = new Date("2026-03-14T14:34:00Z");

const req: ResolveRequest = {
  pair: { source: "BTC", target: "USD" },
  effectiveAt: EFFECTIVE_AT,
};

describe("partitionBucketTs", () => {
  it("methodology §3.2: 14:35:21 → bucket 14:34:00", () => {
    const bucket = partitionBucketTs(EFFECTIVE_AT);
    expect(bucket.toISOString()).toBe("2026-03-14T14:34:00.000Z");
  });

  it("on a clean minute boundary, returns the prior minute", () => {
    const bucket = partitionBucketTs(new Date("2026-03-14T14:35:00Z"));
    expect(bucket.toISOString()).toBe("2026-03-14T14:34:00.000Z");
  });
});

describe("resolve — end-to-end pipeline with mocked sources", () => {
  it("3 sources all succeed → Tier A, median is the highest-volume source's close", async () => {
    const sources: Source[] = [
      new MockSource("kraken", 67200, 18),
      new MockSource("bitstamp", 67220, 5),
      new MockSource("bitfinex", 67180, 6),
    ];

    const result = await resolve(req, sources);

    expect(result.tier).toBe("A");
    expect(result.providerCount).toBe(3);
    // Cumulative walk: bitfinex@67180 (6 → cum 6), kraken@67200 (18 → cum 24 ← crosses 50% of 29)
    expect(result.rate).toBe(67200);
    expect(result.bucketTs.toISOString()).toBe(EXPECTED_BUCKET.toISOString());
    expect(result.audit.providersSucceeded).toEqual(["bitfinex", "kraken", "bitstamp"]);
    expect(result.audit.providersFailed).toEqual([]);
    expect(result.audit.providersZeroVolume).toEqual([]);
  });

  it("2 sources succeed, 1 fails → Tier B with the failure in audit", async () => {
    const sources: Source[] = [
      new MockSource("kraken", 67200, 18),
      new MockSource("bitstamp", 67220, 5),
      new MockSource("bitfinex", 0, 0, "fail"),
    ];

    const result = await resolve(req, sources);

    expect(result.tier).toBe("B");
    expect(result.providerCount).toBe(2);
    expect(result.audit.providersSucceeded).toEqual(["kraken", "bitstamp"]);
    expect(result.audit.providersFailed).toHaveLength(1);
    expect(result.audit.providersFailed[0]!.name).toBe("bitfinex");
    expect(result.audit.providersFailed[0]!.reason).toContain("simulated network failure");
  });

  it("flash crash on one source does NOT drag the result", async () => {
    const sources: Source[] = [
      new MockSource("kraken", 67200, 18),
      new MockSource("bitstamp", 67220, 5),
      new MockSource("bitfinex", 60000, 6), // outlier
    ];

    const result = await resolve(req, sources);
    expect(result.rate).toBe(67200); // unchanged from baseline
  });

  it("only 1 source succeeds → Tier B-single", async () => {
    const sources: Source[] = [
      new MockSource("kraken", 67200, 18),
      new MockSource("bitstamp", 0, 0, "fail"),
      new MockSource("bitfinex", 0, 0, "fail"),
    ];

    const result = await resolve(req, sources);
    expect(result.tier).toBe("B-single");
    expect(result.providerCount).toBe(1);
    expect(result.audit.providersFailed).toHaveLength(2);
  });

  it("zero-volume sources are excluded from the median + tracked in audit", async () => {
    const sources: Source[] = [
      new MockSource("kraken", 67200, 18),
      new MockSource("bitstamp", 67220, 5),
      new MockSource("mempool.space", 67230, 0, "zero-volume"),
    ];

    const result = await resolve(req, sources);
    expect(result.providerCount).toBe(2);
    expect(result.tier).toBe("B");
    expect(result.audit.providersZeroVolume).toEqual(["mempool.space"]);
  });

  it("source returning candle within staleness window contributes (thin-pair handling)", async () => {
    // The "wrong-bucket" MockSource puts its candle 5 minutes off from the
    // expected bucket. Per the thin-pair handling in resolve.ts, this is
    // within MAX_STALENESS_MS so the candle DOES contribute.
    // This documents the thin-volume LatAm pair behavior — for currencies
    // like BTC/MXN that may not have a trade in every minute, the most
    // recent candle within 5 minutes is accepted.
    const sources: Source[] = [
      new MockSource("kraken", 67200, 18),
      new MockSource("bitstamp", 67220, 5, "wrong-bucket"),
    ];

    const result = await resolve(req, sources);
    expect(result.providerCount).toBe(2);
    expect(result.audit.providersSucceeded).toContain("bitstamp");
    expect(result.audit.providersFailed).toEqual([]);
  });

  it("throws when all sources fail (no usable candles at all)", async () => {
    const sources: Source[] = [
      new MockSource("kraken", 0, 0, "fail"),
      new MockSource("bitstamp", 0, 0, "fail"),
    ];

    await expect(resolve(req, sources)).rejects.toThrow(/no contributing sources/);
  });

  it("throws when no sources at all", async () => {
    await expect(resolve(req, [])).rejects.toThrow(/no active sources/);
  });
});
