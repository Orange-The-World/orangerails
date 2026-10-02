import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateAuthenticatedResponse,
  evaluateUnauthenticatedResponse,
  evidenceKeys,
  runAcceptance,
} from "./orbi-v1-rate-acceptance.mjs";

const NOW_MS = Date.parse("2026-09-28T20:00:00.000Z");
const REQUESTED_AT = new Date(NOW_MS).toISOString();

function rateBody(fiat, resolvedAt = REQUESTED_AT) {
  return JSON.stringify({
    asset: "BTC",
    fiat,
    product: "ORBI-M",
    requested_at: REQUESTED_AT,
    resolved_at: resolvedAt,
    rate: "12345.67000000",
    provenance: "withheld from evidence",
    tier: "withheld from evidence",
    source_authority: "ORBI",
    fill_type: resolvedAt === REQUESTED_AT ? "exact" : "forward_fill",
  });
}

test("accepts a fresh authenticated rate without copying sensitive response values", () => {
  const result = evaluateAuthenticatedResponse({
    fiat: "EUR",
    status: 200,
    text: rateBody("EUR"),
    requestedAtMs: NOW_MS,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.evidence), evidenceKeys());
  assert.equal(result.evidence.response_shape, "authenticated_rate_result");
  assert.equal(result.evidence.freshness_seconds, 0);
  assert.equal(JSON.stringify(result.evidence).includes("12345.67"), false);
  assert.equal(JSON.stringify(result.evidence).includes("provenance"), false);
});

test("fails closed on stale, malformed, and unauthenticated-success responses", () => {
  const stale = evaluateAuthenticatedResponse({
    fiat: "GBP",
    status: 200,
    text: rateBody("GBP", "2026-09-28T18:29:59.000Z"),
    requestedAtMs: NOW_MS,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.evidence.freshness_result, "stale");

  const malformed = evaluateAuthenticatedResponse({
    fiat: "USD",
    status: 200,
    text: JSON.stringify({ asset: "BTC", fiat: "USD" }),
    requestedAtMs: NOW_MS,
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.evidence.response_shape, "invalid_rate_shape");

  assert.equal(evaluateUnauthenticatedResponse(401, '{"error":"missing_key"}').ok, true);
  assert.equal(evaluateUnauthenticatedResponse(200, rateBody("USD")).ok, false);
});

test("runs the unauthenticated control first and authenticates all three fixed pairs", async () => {
  const secret = "orbi_sk_test_value_never_printed";
  const calls = [];
  const records = [];

  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), authorization: options.headers.Authorization ?? null });
    if (calls.length === 1) {
      return new Response('{"error":"missing_key"}', { status: 401 });
    }

    const parsed = new URL(url);
    const fiat = parsed.searchParams.get("fiat");
    assert.equal(options.headers.Authorization, `Bearer ${secret}`);
    return new Response(rateBody(fiat), { status: 200 });
  };

  const exitCode = await runAcceptance({
    projectRef: "abcdefghijklmnopqrst",
    apiKey: secret,
    fetchImpl,
    nowMs: NOW_MS,
    emit: (record) => records.push(record),
  });

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 4);
  assert.equal(calls[0].authorization, null);
  assert.deepEqual(
    records.map((record) => record.pair),
    ["unauthenticated-control", "BTC/USD", "BTC/EUR", "BTC/GBP"],
  );
  assert.equal(JSON.stringify(records).includes(secret), false);
});

test("does not run authenticated probes when the unauthenticated gate is open", async () => {
  let calls = 0;
  const records = [];
  const fetchImpl = async () => {
    calls += 1;
    return new Response(rateBody("USD"), { status: 200 });
  };

  const exitCode = await runAcceptance({
    projectRef: "abcdefghijklmnopqrst",
    apiKey: "orbi_sk_test_value_never_printed",
    fetchImpl,
    nowMs: NOW_MS,
    emit: (record) => records.push(record),
  });

  assert.equal(exitCode, 1);
  assert.equal(calls, 1);
  assert.equal(records[0].response_shape, "unauthenticated_gate_failed");
});
