/**
 * supabase/functions/on-demand-resolve — Supabase Deno Edge Function.
 *
 * Given (source, target, effectiveAt), returns a CONFIRMED ORBI-M rate for
 * the 1-minute bucket containing that timestamp. Cache-first:
 *   1. SELECT from exchange_rates. If present, return it (computedOnDemand=false).
 *   2. Else, run the resolve pipeline (direct VW-median or composite via USD),
 *      INSERT the result with provenance='on-demand-resolve', return it
 *      (computedOnDemand=true).
 *
 * Internal writes use SUPABASE_SERVICE_ROLE_KEY (bypasses RLS). The function
 * itself is invokable with the anon key — clients send the OR PROD anon key
 * as the `apikey` header (standard Supabase Edge Function pattern).
 *
 * Rate-limit: ~30 req/min per IP via in-memory Map. Edge instances are short
 * lived so this only protects against per-instance bursts; for cross-instance
 * abuse, lean on Supabase platform rate limits.
 *
 * Response shape matches V3's PinnedRateResult with one extra field
 * (computedOnDemand). See README.md.
 */

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

import { KrakenSource } from "../../../orbi/src/sources/kraken.ts";
import { BitstampSource } from "../../../orbi/src/sources/bitstamp.ts";
import { BitfinexSource } from "../../../orbi/src/sources/bitfinex.ts";
import { MempoolSpaceSource } from "../../../orbi/src/sources/mempool-space.ts";
import { BitsoSource } from "../../../orbi/src/sources/bitso.ts";
import { MercadoBitcoinSource } from "../../../orbi/src/sources/mercado-bitcoin.ts";
import { CoinbaseExchangeSource } from "../../../orbi/src/sources/coinbase-exchange.ts";
import { FrankfurterSource } from "../../../orbi/src/sources/frankfurter.ts";
import { resolve, partitionBucketTs } from "../../../orbi/src/calculate/resolve.ts";
import { resolveComposite } from "../../../orbi/src/calculate/resolve-composite.ts";
import type { Source } from "../../../orbi/src/sources/interface.ts";
import { handleRequest } from "./handler.ts";

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// Composite pairs (Tier C via BTC/USD ORBI x USD/X Frankfurter). Mirrors
// the list in scripts/forward-fill.ts.
export const COMPOSITE_TARGETS = new Set(["INR", "TRY", "ZAR"]);

// Source registry — instantiated once per Edge Function instance, reused
// across invocations on the same instance (warm starts).
const allBtcSources: Source[] = [
  new KrakenSource(),
  new BitstampSource(),
  new BitfinexSource(),
  new MempoolSpaceSource(),
  new BitsoSource(),
  new CoinbaseExchangeSource(),
  new MercadoBitcoinSource(),
];
const frankfurter = new FrankfurterSource();

// Service-role client for writes; built lazily so unit tests can mock it.
let supabaseAdmin: SupabaseClient | null = null;
function getSupabaseAdmin(): SupabaseClient {
  if (supabaseAdmin) return supabaseAdmin;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error(
      "on-demand-resolve: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set",
    );
  }
  supabaseAdmin = createClient(url, key, { auth: { persistSession: false } });
  return supabaseAdmin;
}

// In-memory per-IP rate limit. Reset on cold start; bounded abuse impact
// because instances are short lived.
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const requestLog = new Map<string, number[]>();

export function checkRateLimit(ip: string, now: number = Date.now()): boolean {
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const recent = (requestLog.get(ip) ?? []).filter((t) => t > windowStart);
  if (recent.length >= RATE_LIMIT_MAX) {
    requestLog.set(ip, recent);
    return false;
  }
  recent.push(now);
  requestLog.set(ip, recent);
  return true;
}

const defaultDeps = {
  getClient: getSupabaseAdmin,
  resolveDirect: resolve,
  resolveComposite,
  allBtcSources,
  frankfurter,
  compositeTargets: COMPOSITE_TARGETS,
  checkRateLimit,
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  return handleRequest(req, defaultDeps);
});

export { partitionBucketTs };
