// supabase/functions/world-gateway/index.ts
//
// Truth Data API gateway. The single public surface for orange-world-prod reads.
//
// Auth: Bearer <api_key>  (orw_XXXXX from client-verify-email)
// Validation: SHA-256 hash → client_platform.api_keys → check scopes.truth = true →
//             check current quota window → proxy to orange-world-prod →
//             log usage event → return rows.
//
// GET /functions/v1/world-gateway/precious-metals?metal=gold&from=2020-01-01&to=2024-12-31
// GET /functions/v1/world-gateway/inflation?country=US&from=1900
// GET /functions/v1/world-gateway/historical-money-prices
// GET /functions/v1/world-gateway/bitcoin-network?metric=hashrate
// GET /functions/v1/world-gateway/wages
// GET /functions/v1/world-gateway/monetary-aggregates
// GET /functions/v1/world-gateway/commodity-prices

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// PROD orange-rails-prod (where client_platform lives)
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// orange-world-prod (where truth data actually lives)
const WORLD_DATA_URL = Deno.env.get("ORANGE_WORLD_PROD_URL")!;
const WORLD_DATA_KEY = Deno.env.get("ORANGE_WORLD_PROD_SERVICE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json", ...extra },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const ROUTE_MAP: Record<string, string> = {
  "precious-metals": "precious_metals_rates",
  "inflation": "inflation_rates",
  "historical-money-prices": "historical_money_prices",
  "bitcoin-network": "bitcoin_network_metrics",
  "wages": "wages",
  "monetary-aggregates": "monetary_aggregates",
  "commodity-prices": "commodity_prices",
};

Deno.serve(async (req) => {
  const start = Date.now();
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // --- Auth ---
  const auth = req.headers.get("authorization") || "";
  const match = auth.match(/^Bearer\s+(orw_[a-f0-9]{60})$/);
  if (!match) return json({ error: "missing_or_invalid_api_key" }, 401);
  const rawKey = match[1];
  const keyHashHex = await sha256Hex(rawKey);

  const platform = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: keyRow } = await platform
    .schema("client_platform")
    .from("api_keys")
    .select("id, app_id, scopes, revoked_at, applications:applications!inner(org_id)")
    .eq("key_hash", keyHashHex)
    .is("revoked_at", null)
    .maybeSingle();

  if (!keyRow) return json({ error: "key_invalid_or_revoked" }, 401);
  if (!keyRow.scopes?.truth) return json({ error: "key_missing_truth_scope" }, 403);

  // deno-lint-ignore no-explicit-any
  const orgId = (keyRow.applications as any).org_id as string;

  // --- Parse route ---
  const url = new URL(req.url);
  const pathParts = url.pathname.split("/").filter(Boolean);
  // Path: /<fn_slug>/<endpoint>; e.g. /world-gateway/precious-metals
  const endpoint = pathParts[pathParts.length - 1] || "";
  const tableName = ROUTE_MAP[endpoint];
  if (!tableName) return json({ error: "unknown_endpoint", endpoint }, 404);

  // --- Rate limit check (simple: count requests this hour) ---
  // For Phase 1 this is a count against api_usage; OpenMeter integration comes later.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: hourCount } = await platform
    .schema("client_platform")
    .from("api_usage")
    .select("*", { count: "exact", head: true })
    .eq("key_id", keyRow.id)
    .gte("ts", hourAgo);

  // Hobby tier: 10K/day → ~417/hour. Be generous: cap at 500/hr.
  const HOURLY_LIMIT = 500;
  if ((hourCount ?? 0) >= HOURLY_LIMIT) {
    await logUsage(platform, orgId, keyRow.app_id, keyRow.id, endpoint, 429, Date.now() - start, 0, req);
    return json({ error: "rate_limit_exceeded", retry_after_seconds: 60 }, 429, { "retry-after": "60" });
  }

  // --- Proxy to orange-world-prod ---
  const data = createClient(WORLD_DATA_URL, WORLD_DATA_KEY, {
    auth: { persistSession: false },
  });

  // Build a flexible query: forward known filters from query string
  let query = data.from(tableName).select("*").limit(1000);
  for (const [k, v] of url.searchParams.entries()) {
    if (k === "from") query = query.gte("date", v);
    else if (k === "to") query = query.lte("date", v);
    else if (k === "limit") {
      const n = parseInt(v, 10);
      if (!isNaN(n) && n > 0 && n <= 5000) query = data.from(tableName).select("*").limit(n);
    } else {
      query = query.eq(k, v);
    }
  }

  const { data: rows, error } = await query;
  const status = error ? 500 : 200;
  const latency = Date.now() - start;

  await logUsage(platform, orgId, keyRow.app_id, keyRow.id, endpoint, status, latency, rows?.length ?? 0, req);

  if (error) {
    // Log the full upstream error server-side; never echo it to the caller.
    // Defense-in-depth: if orange-world-prod ever surfaces an error string
    // that contains row-level data or operator-only context, the public
    // truth-data API caller should not see it.
    console.error("data fetch failed", error);
    return json({ error: "data_fetch_failed", detail: "upstream fetch failed" }, 500);
  }

  return json({ ok: true, count: rows?.length ?? 0, rows }, 200);
});

// deno-lint-ignore no-explicit-any
async function logUsage(platform: any, orgId: string, appId: string, keyId: string, endpoint: string, status: number, latencyMs: number, rowsReturned: number, req: Request) {
  const clientIp = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || null;
  await platform.schema("client_platform").from("api_usage").insert({
    org_id: orgId,
    app_id: appId,
    key_id: keyId,
    product: "truth",
    endpoint,
    status,
    latency_ms: latencyMs,
    rows_returned: rowsReturned,
    client_ip: clientIp,
  });
  // Don't await touching last_used_at — fire and forget
  platform.schema("client_platform").from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", keyId).then();
}
