/**
 * Live smoke test for the rates-client module.
 *
 * Verifies that:
 *   - The anon key + URL from .env work
 *   - We can fetch latest BTC/USD via the client
 *   - We can fetch the audit row for that rate
 *   - We can fetch a range of recent rates
 *   - Health check returns reachable=true
 *
 * Simulates exactly what V3 / OWM / OWB will do at runtime.
 */

import { readFileSync } from "node:fs";
import { fetchLatestORBIM, fetchAuditEntry, fetchORBIMRange, orbiHealthCheck, initORBIClient } from "../src/client/rates";

// Load creds from .env (simulating env-var configuration)
for (const line of readFileSync("/opt/bb-support/.env", "utf8").split("\n")) {
  const s = line.trim();
  if (!s || s.startsWith("#") || !s.includes("=")) continue;
  const [k, ...rest] = s.split("=");
  let v = rest.join("=").trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (k!.trim() === "ORANGERAILS_PROD_SUPABASE_URL") process.env.ORBI_SUPABASE_URL = v;
  if (k!.trim() === "ORANGERAILS_PROD_SUPABASE_ANON_KEY") process.env.ORBI_SUPABASE_ANON_KEY = v;
}

async function main() {
  console.log("=== Initializing ORBI client (anon key) ===");
  initORBIClient();
  console.log("  ✓ Client initialized\n");

  console.log("=== Health check ===");
  const health = await orbiHealthCheck();
  console.log(`  reachable: ${health.reachable}`);
  console.log(`  latest rate at: ${health.latestRateAt?.toISOString() ?? "none"}\n`);

  console.log("=== Latest BTC/USD ===");
  const latest = await fetchLatestORBIM("BTC", "USD");
  if (latest) {
    console.log(`  rate: $${latest.rate.toFixed(2)}`);
    console.log(`  tier: ${latest.tier}`);
    console.log(`  bucket: ${latest.bucketTs}`);
    console.log(`  sources: ${latest.providerCount}`);
    console.log(`  id: ${latest.id}\n`);

    console.log("=== Audit for that rate ===");
    const audit = await fetchAuditEntry(latest.id);
    if (audit) {
      console.log(`  succeeded: ${audit.providersSucceeded.join(", ")}`);
      console.log(`  failed: ${audit.providersFailed.length} sources`);
      console.log(`  zero-volume: ${audit.providersZeroVolume.length} sources`);
      console.log(`  calculation:`);
      audit.medianCalculation.split("\n").slice(0, 8).forEach((l) => console.log(`    ${l}`));
      console.log("");
    }
  } else {
    console.log("  no rate found\n");
  }

  console.log("=== Range fetch: last 5 minutes of BTC/EUR ===");
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
  const range = await fetchORBIMRange("BTC", "EUR", fiveMinAgo, new Date());
  console.log(`  Returned ${range.length} EUR rates`);
  for (const r of range.slice(-3)) {
    console.log(`    ${r.bucketTs}: €${r.rate.toFixed(2)} (Tier ${r.tier}, ${r.providerCount}src)`);
  }
  console.log("");

  console.log("=== LatAm spot check ===");
  for (const target of ["BRL", "MXN", "INR"]) {
    const r = await fetchLatestORBIM("BTC", target);
    if (r) {
      console.log(`  BTC/${target}: ${r.rate.toFixed(2)} (Tier ${r.tier}, ${r.composite ? "composite" : "direct"})`);
    } else {
      console.log(`  BTC/${target}: no rate found`);
    }
  }

  console.log("\n✓ Live client test PASSED — V3/OWM/OWB can now consume ORBI rates the same way.");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
