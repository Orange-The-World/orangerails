/**
 * Local smoke test for the deployed on-demand-resolve Edge Function.
 *
 * Runs from bb-support against PROD. Reads OR PROD URL + anon key from
 * /opt/bb-support/.env (same pattern as forward-fill.ts).
 *
 * Usage:
 *   bun run scripts/test-edge-function.ts
 *
 * What it asserts:
 *   1. Cache HIT — recent forward-fill minute returns computedOnDemand=false.
 *   2. Cache MISS — old minute (no forward-fill coverage) returns
 *      computedOnDemand=true.
 *   3. Cache POPULATED — same old minute called again returns
 *      computedOnDemand=false.
 *   4. Composite path — BTC/INR (Tier C) returns provider string with
 *      "C-composite".
 *
 * If the function isn't deployed yet, this exits non-zero with a clear error.
 */

import { readFileSync } from "node:fs";

const env: Record<string, string> = {};
for (const line of readFileSync("/opt/bb-support/.env", "utf8").split("\n")) {
  const s = line.trim();
  if (!s || s.startsWith("#") || !s.includes("=")) continue;
  const [k, ...rest] = s.split("=");
  let v = rest.join("=").trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  env[k!.trim()] = v;
}

const URL = env.ORANGERAILS_PROD_SUPABASE_URL!;
const ANON_KEY =
  env.ORANGERAILS_PROD_SUPABASE_ANON_KEY ??
  env.ORANGERAILS_PROD_ANON_KEY ??
  env.ORBI_SUPABASE_ANON_KEY;

if (!URL || !ANON_KEY) {
  console.error("Missing ORANGERAILS_PROD_SUPABASE_URL or anon key in /opt/bb-support/.env");
  process.exit(1);
}

const ENDPOINT = `${URL.replace(/\/$/, "")}/functions/v1/on-demand-resolve`;

async function callEdge(
  source: string,
  target: string,
  effectiveAt: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ source, target, effectiveAt }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    process.exitCode = 1;
  }
}

async function main() {
  console.log(`Smoke-testing ${ENDPOINT}`);
  console.log("");

  // Pick a minute that's safely in the past + within forward-fill coverage
  // (~10 min ago, when the cron has definitely written).
  const recentBucket = new Date(Date.now() - 10 * 60 * 1000);

  // Pick an OLD minute that forward-fill hasn't covered. Forward-fill started
  // 2026-05-26T12:00 UTC, so any timestamp before that is guaranteed miss.
  const oldMinute = new Date("2025-08-12T16:42:31Z");

  console.log("1) Cache HIT (recent forward-fill minute)");
  const r1 = await callEdge("BTC", "USD", recentBucket.toISOString());
  console.log(`   HTTP ${r1.status} computedOnDemand=${r1.body.computedOnDemand} rate=${r1.body.rate}`);
  check("HTTP 200", r1.status === 200);
  check("computedOnDemand=false", r1.body.computedOnDemand === false, JSON.stringify(r1.body));
  check("rate is a number", typeof r1.body.rate === "number");
  console.log("");

  console.log("2) Cache MISS (old minute)");
  const r2 = await callEdge("BTC", "USD", oldMinute.toISOString());
  console.log(`   HTTP ${r2.status} computedOnDemand=${r2.body.computedOnDemand} rate=${r2.body.rate}`);
  check("HTTP 200", r2.status === 200);
  check("computedOnDemand=true", r2.body.computedOnDemand === true, JSON.stringify(r2.body));
  check("rate is a number", typeof r2.body.rate === "number");
  console.log("");

  console.log("3) Cache POPULATED (same old minute again)");
  const r3 = await callEdge("BTC", "USD", oldMinute.toISOString());
  console.log(`   HTTP ${r3.status} computedOnDemand=${r3.body.computedOnDemand} rate=${r3.body.rate}`);
  check("HTTP 200", r3.status === 200);
  check("computedOnDemand=false after first miss", r3.body.computedOnDemand === false, JSON.stringify(r3.body));
  check("rate matches first miss", r3.body.rate === r2.body.rate);
  console.log("");

  console.log("4) Composite path (BTC/INR old minute)");
  const r4 = await callEdge("BTC", "INR", new Date("2025-09-01T10:15:00Z").toISOString());
  console.log(`   HTTP ${r4.status} provider="${r4.body.provider}"`);
  check("HTTP 200", r4.status === 200);
  check("provider contains C-composite", String(r4.body.provider ?? "").includes("C-composite"));
  console.log("");

  if (process.exitCode) {
    console.log("FAILED");
  } else {
    console.log("ALL PASS");
  }
}

main().catch((err) => {
  console.error("Smoke test errored:", err);
  process.exit(1);
});
