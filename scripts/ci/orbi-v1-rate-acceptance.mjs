import { pathToFileURL } from "node:url";

const BODY_LIMIT_BYTES = 64 * 1024;
const FRESHNESS_LIMIT_SECONDS = 90 * 60;
const REQUEST_TIMEOUT_MS = 20_000;
const FIATS = ["USD", "EUR", "GBP"];
const EVIDENCE_KEYS = [
  "pair",
  "http_status",
  "response_shape",
  "resolved_at",
  "freshness_seconds",
  "freshness_limit_seconds",
  "freshness_result",
];

function evidence(
  pair,
  httpStatus,
  responseShape,
  resolvedAt = null,
  freshnessSeconds = null,
  freshnessResult = "not_evaluated",
) {
  return {
    pair,
    http_status: httpStatus,
    response_shape: responseShape,
    resolved_at: resolvedAt,
    freshness_seconds: freshnessSeconds,
    freshness_limit_seconds: FRESHNESS_LIMIT_SECONDS,
    freshness_result: freshnessResult,
  };
}

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function evaluateUnauthenticatedResponse(status, text) {
  const body = parseObject(text);
  const ok = status === 401 && body?.error === "missing_key";
  return {
    ok,
    evidence: evidence(
      "unauthenticated-control",
      status,
      ok ? "unauthenticated_missing_key" : "unauthenticated_gate_failed",
    ),
  };
}

export function evaluateAuthenticatedResponse({ fiat, status, text, requestedAtMs }) {
  const pair = `BTC/${fiat}`;
  if (status !== 200) {
    return { ok: false, evidence: evidence(pair, status, "authenticated_http_error") };
  }

  const body = parseObject(text);
  if (!body) {
    return { ok: false, evidence: evidence(pair, status, "invalid_json_shape") };
  }

  const resolvedAtMs = Date.parse(body.resolved_at);
  const requestedEchoMs = Date.parse(body.requested_at);
  const validShape =
    body.asset === "BTC" &&
    body.fiat === fiat &&
    body.product === "ORBI-M" &&
    requestedEchoMs === requestedAtMs &&
    Number.isFinite(resolvedAtMs) &&
    typeof body.rate === "string" &&
    /^[0-9]+(?:\.[0-9]+)?$/.test(body.rate) &&
    Number(body.rate) > 0 &&
    (body.fill_type === "exact" || body.fill_type === "forward_fill") &&
    !Object.hasOwn(body, "error");

  if (!validShape) {
    return { ok: false, evidence: evidence(pair, status, "invalid_rate_shape") };
  }

  const freshnessSeconds = Math.floor((requestedAtMs - resolvedAtMs) / 1000);
  const fresh = freshnessSeconds >= 0 && freshnessSeconds <= FRESHNESS_LIMIT_SECONDS;
  return {
    ok: fresh,
    evidence: evidence(
      pair,
      status,
      "authenticated_rate_result",
      new Date(resolvedAtMs).toISOString(),
      freshnessSeconds,
      fresh ? "fresh" : "stale",
    ),
  };
}

async function readBodyBounded(response) {
  if (!response.body) return { text: "", tooLarge: false };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BODY_LIMIT_BYTES) {
      await reader.cancel();
      return { text: "", tooLarge: true };
    }
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return { text, tooLarge: false };
}

async function fetchEvidence(fetchImpl, url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    const body = await readBodyBounded(response);
    return {
      status: response.status,
      text: body.text,
      tooLarge: body.tooLarge,
    };
  } catch {
    return { status: 0, text: "", tooLarge: false };
  } finally {
    clearTimeout(timer);
  }
}

function minuteTimestamp(nowMs) {
  return new Date(Math.floor(nowMs / 60_000) * 60_000).toISOString();
}

export async function runAcceptance({
  projectRef,
  apiKey,
  fetchImpl = fetch,
  nowMs = Date.now(),
  emit = console.log,
}) {
  if (!/^[a-z0-9]{20}$/.test(projectRef ?? "") || !apiKey || apiKey.trim() !== apiKey) {
    emit(evidence("configuration", 0, "configuration_invalid"));
    return 1;
  }

  const endpoint = `https://${projectRef}.supabase.co/functions/v1/v1-rate`;
  const unauthenticated = await fetchEvidence(fetchImpl, endpoint, { Accept: "application/json" });
  const unauthenticatedResult = unauthenticated.tooLarge
    ? {
        ok: false,
        evidence: evidence("unauthenticated-control", unauthenticated.status, "response_too_large"),
      }
    : evaluateUnauthenticatedResponse(unauthenticated.status, unauthenticated.text);
  emit(unauthenticatedResult.evidence);

  if (!unauthenticatedResult.ok) return 1;

  const requestedAt = minuteTimestamp(nowMs);
  const requestedAtMs = Date.parse(requestedAt);
  let failed = false;

  for (const fiat of FIATS) {
    const url = new URL(endpoint);
    url.searchParams.set("asset", "BTC");
    url.searchParams.set("fiat", fiat);
    url.searchParams.set("at", requestedAt);
    url.searchParams.set("product", "ORBI-M");

    const response = await fetchEvidence(fetchImpl, url, {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    });
    const result = response.tooLarge
      ? { ok: false, evidence: evidence(`BTC/${fiat}`, response.status, "response_too_large") }
      : evaluateAuthenticatedResponse({
          fiat,
          status: response.status,
          text: response.text,
          requestedAtMs,
        });
    emit(result.evidence);
    if (!result.ok) failed = true;
  }

  return failed ? 1 : 0;
}

export function evidenceKeys() {
  return [...EVIDENCE_KEYS];
}

async function main() {
  const records = [];
  const exitCode = await runAcceptance({
    projectRef: process.env.ORBI_PROJECT_REF,
    apiKey: process.env.ORBI_API_KEY,
    emit: (record) => records.push(record),
  });
  for (const record of records) console.log(JSON.stringify(record));
  return exitCode;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) process.exitCode = await main();
