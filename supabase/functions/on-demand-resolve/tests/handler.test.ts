/**
 * Unit tests for the on-demand-resolve HTTP handler.
 *
 * Mocks the Supabase client + the resolve functions. Asserts:
 *   - Param validation (missing / wrong source / bad timestamp / future ts)
 *   - Cache HIT returns computedOnDemand=false
 *   - Cache MISS calls resolve(), writes, returns computedOnDemand=true
 *   - Composite path is taken for INR/TRY/ZAR
 *   - Rate-limit returns 429
 *   - CORS / 405 / 400 / 502
 *
 * Run with: deno test --allow-net --allow-env tests/handler.test.ts
 */

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleRequest, type HandlerDeps } from "../handler.ts";
import type { ResolveResult } from "../../../src/calculate/resolve.ts";
import type { CompositeResolveResult } from "../../../src/calculate/resolve-composite.ts";
import type { Source } from "../../../src/sources/interface.ts";

// ---- Mock Supabase query builder ----
//
// supabase-js uses a fluent builder where chained methods return `this` and
// the chain is terminated by maybeSingle(), single(), or a then. We only
// implement the surface the handler actually calls.

interface MockTable {
  rows: Record<string, unknown>[];
  /** If set, every operation returns this error. */
  forceError?: { message: string };
}

class MockSupabase {
  tables: Record<string, MockTable> = {
    exchange_rates: { rows: [] },
    exchange_rate_resolutions: { rows: [] },
  };

  // Track every insert/upsert for assertions
  inserts: { table: string; row: Record<string, unknown> }[] = [];

  from(table: string) {
    return new MockQueryBuilder(this, table);
  }
}

class MockQueryBuilder {
  private filters: Record<string, unknown> = {};
  private mode: "select" | "insert" | "upsert" = "select";
  private pendingRow: Record<string, unknown> | null = null;
  private selectCols = "";

  constructor(private parent: MockSupabase, private table: string) {}

  select(cols: string) {
    this.selectCols = cols;
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters[col] = val;
    return this;
  }
  upsert(row: Record<string, unknown>, _opts?: unknown) {
    this.mode = "upsert";
    this.pendingRow = row;
    return this;
  }
  insert(row: Record<string, unknown>) {
    this.mode = "insert";
    this.pendingRow = row;
    return this;
  }
  async maybeSingle() {
    const t = this.parent.tables[this.table];
    if (!t) return { data: null, error: null };
    if (t.forceError) return { data: null, error: t.forceError };
    const hit = t.rows.find((r) =>
      Object.entries(this.filters).every(([k, v]) => r[k] === v),
    ) ?? null;
    return { data: hit, error: null };
  }
  async single() {
    // Used by upsert(...).select('id').single()
    if (this.mode === "upsert" && this.pendingRow) {
      const row = { ...this.pendingRow, id: `mock-rate-${this.parent.inserts.length + 1}` };
      this.parent.inserts.push({ table: this.table, row });
      this.parent.tables[this.table]?.rows.push(row);
      return { data: { id: row.id }, error: null };
    }
    return { data: null, error: { message: "single() called without upsert" } };
  }
  // For insert without select chain , returns a thenable
  then<T>(resolve: (v: { data: null; error: null }) => T) {
    if (this.mode === "insert" && this.pendingRow) {
      this.parent.inserts.push({ table: this.table, row: this.pendingRow });
      this.parent.tables[this.table]?.rows.push(this.pendingRow);
    }
    return Promise.resolve(resolve({ data: null, error: null }));
  }
}

// ---- Mock sources / resolve functions ----

const mockSource: Source = {
  name: "mock-kraken",
  role: "primary",
  pairsSupported: ["BTC-USD", "BTC-EUR", "BTC-MXN"],
  rateLimitRps: 10,
  userAgent: "test",
  // deno-lint-ignore require-await
  async fetch() {
    return { source: "mock-kraken", candles: [], success: true, fetchedAt: new Date() };
  },
  // deno-lint-ignore require-await
  async healthCheck() {
    return { name: "mock-kraken", reachable: true };
  },
};

function makeDeps(
  overrides: Partial<HandlerDeps> = {},
  supabase: MockSupabase = new MockSupabase(),
): { deps: HandlerDeps; supabase: MockSupabase } {
  const deps: HandlerDeps = {
    // deno-lint-ignore no-explicit-any
    getClient: () => supabase as any,
    resolveDirect: async (req, _sources): Promise<ResolveResult> => ({
      rate: 67000.5,
      bucketTs: new Date("2026-01-01T12:00:00Z"),
      tier: "A",
      providerCount: 4,
      audit: {
        providerResponses: { "mock-kraken": { source: "mock-kraken", candles: [], success: true, fetchedAt: new Date() } },
        providersSucceeded: ["mock-kraken", "mock-bitstamp", "mock-bitfinex", "mock-coinbase"],
        providersFailed: [],
        providersZeroVolume: [],
        calculationLog: "vwm walk: ...",
      },
    }),
    resolveComposite: async (_req): Promise<CompositeResolveResult> => ({
      rate: 5_900_000,
      bucketTs: new Date("2026-01-01T12:00:00Z"),
      tier: "C-composite",
      composite: true,
      compositeVia: "BTC-USD * USD-INR",
      btcUsd: {
        rate: 67000.5,
        bucketTs: new Date("2026-01-01T12:00:00Z"),
        tier: "A",
        providerCount: 4,
        audit: {
          providerResponses: {},
          providersSucceeded: ["mock-kraken"],
          providersFailed: [],
          providersZeroVolume: [],
          calculationLog: "vwm walk",
        },
      },
      crossRate: 88.06,
      audit: {
        btcUsdResolution: {
          providerResponses: {},
          providersSucceeded: ["mock-kraken"],
          providersFailed: [],
          providersZeroVolume: [],
          calculationLog: "vwm walk",
        },
        crossRateSource: "frankfurter",
        crossRateValue: 88.06,
        formula: "BTC/INR = BTC/USD (67000.50) * USD/INR (88.060000) = 5900050.50",
      },
    }),
    allBtcSources: [mockSource],
    frankfurter: mockSource,
    compositeTargets: new Set(["INR", "TRY", "ZAR"]),
    checkRateLimit: () => true,
    ...overrides,
  };
  return { deps, supabase };
}

function mkReq(qs: Record<string, string>, method = "GET"): Request {
  const u = new URL("https://example.com/on-demand-resolve");
  for (const [k, v] of Object.entries(qs)) u.searchParams.set(k, v);
  return new Request(u.toString(), { method });
}

// ---- Tests ----

Deno.test("returns 400 when source / target / effectiveAt missing", async () => {
  const { deps } = makeDeps();
  const res = await handleRequest(mkReq({ source: "BTC" }), deps);
  assertEquals(res.status, 400);
  const body = await res.json();
  assert(body.error.includes("required"));
});

Deno.test("returns 400 for non-BTC source", async () => {
  const { deps } = makeDeps();
  const res = await handleRequest(
    mkReq({ source: "ETH", target: "USD", effectiveAt: "2026-01-01T12:00:00Z" }),
    deps,
  );
  assertEquals(res.status, 400);
});

Deno.test("returns 400 for malformed effectiveAt", async () => {
  const { deps } = makeDeps();
  const res = await handleRequest(
    mkReq({ source: "BTC", target: "USD", effectiveAt: "not-a-date" }),
    deps,
  );
  assertEquals(res.status, 400);
});

Deno.test("returns 400 for future effectiveAt", async () => {
  const { deps } = makeDeps();
  const future = new Date(Date.now() + 60_000).toISOString();
  const res = await handleRequest(
    mkReq({ source: "BTC", target: "USD", effectiveAt: future }),
    deps,
  );
  assertEquals(res.status, 400);
});

Deno.test("cache HIT returns computedOnDemand=false", async () => {
  const supabase = new MockSupabase();
  supabase.tables.exchange_rates.rows.push({
    id: "cached-id-1",
    rate: 66500.25,
    bucket_ts: "2026-01-01T11:59:00.000Z",
    tier: "A",
    provider_count: 5,
    composite: false,
    source_currency: "BTC",
    target_currency: "USD",
    product: "ORBI-M",
    granularity: "1m",
    status: "CONFIRMED",
  });
  const { deps } = makeDeps({}, supabase);
  const res = await handleRequest(
    mkReq({ source: "BTC", target: "USD", effectiveAt: "2026-01-01T12:00:00Z" }),
    deps,
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.computedOnDemand, false);
  assertEquals(body.rate, 66500.25);
  assertEquals(body.rateId, "cached-id-1");
  assertEquals(body.bucketGranularity, "M");
  assertEquals(body.pending, false);
  assertEquals(supabase.inserts.length, 0);
});

Deno.test("cache MISS runs resolve, writes, returns computedOnDemand=true", async () => {
  const { deps, supabase } = makeDeps();
  const res = await handleRequest(
    mkReq({ source: "BTC", target: "USD", effectiveAt: "2026-01-01T12:00:00Z" }),
    deps,
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.computedOnDemand, true);
  assertEquals(body.rate, 67000.5);
  assert(body.provider.includes("tier A"));
  // Two writes: one to exchange_rates (upsert), one to exchange_rate_resolutions
  const rateWrites = supabase.inserts.filter((i) => i.table === "exchange_rates");
  assertEquals(rateWrites.length, 1);
  assertEquals(rateWrites[0].row.provenance, "on-demand-resolve");
  const auditWrites = supabase.inserts.filter((i) => i.table === "exchange_rate_resolutions");
  assertEquals(auditWrites.length, 1);
});

Deno.test("composite path used for INR", async () => {
  const { deps, supabase } = makeDeps();
  const res = await handleRequest(
    mkReq({ source: "BTC", target: "INR", effectiveAt: "2026-01-01T12:00:00Z" }),
    deps,
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.computedOnDemand, true);
  assert(body.provider.includes("C-composite"));
  assertEquals(body.rate, 5_900_000);
  const rateWrites = supabase.inserts.filter((i) => i.table === "exchange_rates");
  assertEquals(rateWrites[0].row.tier, "C-composite");
  assertEquals(rateWrites[0].row.composite, true);
});

Deno.test("404 when target has no direct source and isn't composite", async () => {
  const { deps } = makeDeps();
  const res = await handleRequest(
    mkReq({ source: "BTC", target: "XYZ", effectiveAt: "2026-01-01T12:00:00Z" }),
    deps,
  );
  assertEquals(res.status, 404);
});

Deno.test("rate-limit returns 429", async () => {
  const { deps } = makeDeps({ checkRateLimit: () => false });
  const res = await handleRequest(
    mkReq({ source: "BTC", target: "USD", effectiveAt: "2026-01-01T12:00:00Z" }),
    deps,
  );
  assertEquals(res.status, 429);
});

Deno.test("502 when resolve throws", async () => {
  const { deps } = makeDeps({
    resolveDirect: () => Promise.reject(new Error("all sources failed")),
  });
  const res = await handleRequest(
    mkReq({ source: "BTC", target: "USD", effectiveAt: "2026-01-01T12:00:00Z" }),
    deps,
  );
  assertEquals(res.status, 502);
  const body = await res.json();
  assert(body.error.includes("all sources failed"));
});

Deno.test("405 for unsupported method", async () => {
  const { deps } = makeDeps();
  const req = new Request("https://example.com/on-demand-resolve", { method: "DELETE" });
  const res = await handleRequest(req, deps);
  assertEquals(res.status, 405);
});

Deno.test("POST body params accepted", async () => {
  const { deps } = makeDeps();
  const req = new Request("https://example.com/on-demand-resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "BTC",
      target: "USD",
      effectiveAt: "2026-01-01T12:00:00Z",
    }),
  });
  const res = await handleRequest(req, deps);
  assertEquals(res.status, 200);
});

Deno.test("CORS headers present on success", async () => {
  const { deps } = makeDeps();
  const res = await handleRequest(
    mkReq({ source: "BTC", target: "USD", effectiveAt: "2026-01-01T12:00:00Z" }),
    deps,
  );
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
});
