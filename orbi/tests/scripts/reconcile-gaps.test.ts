/**
 * Reconciler unit tests — mock the resolve orchestrator + Supabase to verify
 * the upgrade decision logic without touching the network or PROD.
 */

import { describe, expect, it, vi } from "vitest";
import {
  pickUpgradeCandidates,
  reconcile,
  type ReconcileSummary,
} from "../../scripts/reconcile-gaps";
import type { ResolveResult } from "../../src/calculate/resolve";
import type { Source } from "../../src/sources/interface";
import type { HealthStatus, Pair, SourceResponse } from "../../src/sources/types";

class StubSource implements Source {
  readonly role = "primary" as const;
  readonly pairsSupported = ["BTC-USD", "BTC-EUR", "BTC-GBP", "BTC-BRL"];
  readonly rateLimitRps = 10;
  readonly userAgent = "test";
  constructor(readonly name: string) {}
  async fetch(_p: Pair, _f: Date, _t: Date): Promise<SourceResponse> {
    return { source: this.name, candles: [], success: true, fetchedAt: new Date() };
  }
  async healthCheck(): Promise<HealthStatus> {
    return { name: this.name, reachable: true, lastSuccessAt: new Date() };
  }
}

function makeRow(target: string, tier: string, providerCount: number, bucketMin = 5) {
  const t = new Date(Date.now() - bucketMin * 60_000);
  return {
    id: `id-${target}-${bucketMin}`,
    target_currency: target,
    bucket_ts: t.toISOString(),
    tier,
    provider_count: providerCount,
  };
}

describe("pickUpgradeCandidates — pair policy", () => {
  it("Tier-A pairs below max provider_count are picked", () => {
    const rows = [
      makeRow("USD", "B", 2), // achievable=4, below → pick
      makeRow("USD", "A", 4), // at max → skip
      makeRow("USD", "A", 5), // above (shouldn't happen) → skip
    ];
    const picked = pickUpgradeCandidates(rows);
    expect(picked).toHaveLength(1);
    expect(picked[0]!.candidate.id).toBe("id-USD-5");
  });

  it("Tier-B BRL: bitso+mercado_bitcoin → max 2; below 2 picked", () => {
    const rows = [makeRow("BRL", "B-single", 1), makeRow("BRL", "B", 2)];
    const picked = pickUpgradeCandidates(rows);
    expect(picked).toHaveLength(1);
    expect(picked[0]!.candidate.target_currency).toBe("BRL");
    expect(picked[0]!.candidate.provider_count).toBe(1);
  });

  it("MXN + ARS (B-single by design) ALWAYS skipped", () => {
    const rows = [
      makeRow("MXN", "B-single", 1),
      makeRow("ARS", "B-single", 1),
    ];
    expect(pickUpgradeCandidates(rows)).toHaveLength(0);
  });

  it("CAD/AUD/JPY/CHF (mempool-second-source) skipped — no historical fetch for mempool", () => {
    const rows = [
      makeRow("CAD", "B-single", 1),
      makeRow("AUD", "B-single", 1),
      makeRow("JPY", "B-single", 1),
      makeRow("CHF", "B-single", 1),
    ];
    expect(pickUpgradeCandidates(rows)).toHaveLength(0);
  });

  it("Composite pairs (INR/TRY/ZAR) skipped — reconciler handles direct only", () => {
    const rows = [
      makeRow("INR", "C-composite", 1),
      makeRow("TRY", "C-composite", 1),
      makeRow("ZAR", "C-composite", 1),
    ];
    expect(pickUpgradeCandidates(rows)).toHaveLength(0);
  });

  it("Unknown target currency is skipped", () => {
    const rows = [makeRow("XYZ", "B", 1)];
    expect(pickUpgradeCandidates(rows)).toHaveLength(0);
  });
});

describe("reconcile — upgrade decision", () => {
  it("UPSERT only when new provider_count > current", async () => {
    const rows = [
      makeRow("USD", "B", 2), // currently 2, achievable 4
      makeRow("EUR", "A", 3), // already at max → not even attempted
    ];
    const writeFn = vi.fn().mockResolvedValue(undefined);
    const resolveFn = vi.fn().mockResolvedValue({
      rate: 67200,
      bucketTs: new Date(rows[0]!.bucket_ts),
      tier: "A",
      providerCount: 4,
      audit: {
        providerResponses: {},
        providersSucceeded: ["kraken", "bitstamp", "bitfinex", "coinbase_exchange"],
        providersFailed: [],
        providersZeroVolume: [],
        calculationLog: "ok",
      },
    } satisfies ResolveResult);

    const summary: ReconcileSummary = await reconcile(rows, {
      dryRun: false,
      writeFn,
      resolveFn,
      sourcesForTarget: () => [new StubSource("k"), new StubSource("b")],
      logSink: () => {},
    });

    expect(summary.scanned).toBe(2);
    expect(summary.attempted).toBe(1); // EUR skipped (at max)
    expect(summary.upgraded).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(writeFn).toHaveBeenCalledOnce();
    expect(writeFn).toHaveBeenCalledWith("USD", expect.objectContaining({ providerCount: 4 }));
  });

  it("does NOT write when re-resolve returns same-or-fewer providers", async () => {
    const rows = [makeRow("USD", "B", 2)];
    const writeFn = vi.fn();
    const resolveFn = vi.fn().mockResolvedValue({
      rate: 67200,
      bucketTs: new Date(rows[0]!.bucket_ts),
      tier: "B",
      providerCount: 2, // SAME as current — must not upgrade
      audit: {
        providerResponses: {},
        providersSucceeded: ["kraken", "bitstamp"],
        providersFailed: [],
        providersZeroVolume: [],
        calculationLog: "ok",
      },
    } satisfies ResolveResult);

    const summary = await reconcile(rows, {
      dryRun: false,
      writeFn,
      resolveFn,
      sourcesForTarget: () => [],
      logSink: () => {},
    });

    expect(summary.upgraded).toBe(0);
    expect(summary.unchanged).toBe(1);
    expect(writeFn).not.toHaveBeenCalled();
  });

  it("dry-run never writes, even on upgrade", async () => {
    const rows = [makeRow("USD", "B-single", 1)];
    const writeFn = vi.fn();
    const resolveFn = vi.fn().mockResolvedValue({
      rate: 67200,
      bucketTs: new Date(rows[0]!.bucket_ts),
      tier: "A",
      providerCount: 4,
      audit: {
        providerResponses: {},
        providersSucceeded: ["k", "b", "f", "c"],
        providersFailed: [],
        providersZeroVolume: [],
        calculationLog: "ok",
      },
    } satisfies ResolveResult);

    const summary = await reconcile(rows, {
      dryRun: true,
      writeFn,
      resolveFn,
      sourcesForTarget: () => [],
      logSink: () => {},
    });

    expect(summary.upgraded).toBe(1);
    expect(writeFn).not.toHaveBeenCalled();
  });

  it("captures resolve failures without aborting the batch", async () => {
    const rows = [
      makeRow("USD", "B-single", 1, 3),
      makeRow("EUR", "B-single", 1, 4),
    ];
    const writeFn = vi.fn();
    const resolveFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("kraken timed out"))
      .mockResolvedValueOnce({
        rate: 67200,
        bucketTs: new Date(rows[1]!.bucket_ts),
        tier: "A",
        providerCount: 3,
        audit: {
          providerResponses: {},
          providersSucceeded: ["k", "b", "c"],
          providersFailed: [],
          providersZeroVolume: [],
          calculationLog: "ok",
        },
      } satisfies ResolveResult);

    const summary = await reconcile(rows, {
      dryRun: false,
      writeFn,
      resolveFn,
      sourcesForTarget: () => [],
      logSink: () => {},
    });

    expect(summary.attempted).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.upgraded).toBe(1);
    expect(writeFn).toHaveBeenCalledOnce();
  });

  it("BRL upgrade from B-single (1) → B (2) UPSERTs correctly", async () => {
    const rows = [makeRow("BRL", "B-single", 1)];
    const writeFn = vi.fn().mockResolvedValue(undefined);
    const resolveFn = vi.fn().mockResolvedValue({
      rate: 350000,
      bucketTs: new Date(rows[0]!.bucket_ts),
      tier: "B",
      providerCount: 2,
      audit: {
        providerResponses: {},
        providersSucceeded: ["bitso", "mercado_bitcoin"],
        providersFailed: [],
        providersZeroVolume: [],
        calculationLog: "ok",
      },
    } satisfies ResolveResult);

    const summary = await reconcile(rows, {
      dryRun: false,
      writeFn,
      resolveFn,
      sourcesForTarget: () => [],
      logSink: () => {},
    });

    expect(summary.upgraded).toBe(1);
    expect(writeFn).toHaveBeenCalledWith("BRL", expect.objectContaining({ tier: "B", providerCount: 2 }));
  });
});
