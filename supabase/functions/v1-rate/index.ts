// supabase/functions/v1-rate/index.ts
// ORBI Point-in-Time Rate API v1
// Authored: ORBI agent, 2026-07-22
// Updated: Dev 1, 2026-07-22 -- DBA index corrections: product param, authority/status/superseded filters
// Updated: Dev 1, 2026-07-22 -- Auditor fixes: gateway config, env flag gate
// Updated: Dev 1, 2026-07-22 -- Surface DB errors as 500; do not mask as fill_type:gap
// Updated: Dev 1, 2026-07-22 -- CTO fix: rate-limit bucket by 16-char prefix (unique per key), not 8-char orbi_sk_
// Updated: Dev 1, 2026-07-22 -- ORBI fix: rate-limit bucket by consumer_id (unique per consumer, format-independent)
// Updated: Dev 2, 2026-07-22 -- P2 fixes: flag gate, keyErr 5xx, body validation, UTC timestamp, hasOwn, await usage log
// Updated: Dev 1, 2026-07-22 -- ISO_UTC_RE: Z suffix only (spec says offset timestamps return 400)
// Updated: Security, 2026-07-23 -- key lookup uses maybeSingle so a bad or revoked key returns 401, not 500

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0'
import { wrapSentryHandler, reportError } from '../_shared/sentry.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const RATE_LIMIT_RPM = parseInt(Deno.env.get('RATE_LIMIT_RPM') ?? '60')
const BATCH_LIMIT = parseInt(Deno.env.get('BATCH_LIMIT') ?? '50')

// Product registry: each product maps 1:1 to a granularity.
// ORBI-M   = 1-minute bars, crypto pairs (BTC, USDC, USDT, DAI, EURC, PYUSD)
// ORBI-D   = 1-day bars, crypto + major fiat (BTC, USD, EURC)
// ORBI-D-authority = 1-day central-bank fiat pairs (USD, EUR, GBP, AUD)
const VALID_PRODUCTS: Record<string, { granularity: string }> = {
  'ORBI-M': { granularity: '1m' },
  'ORBI-D': { granularity: '1d' },
  'ORBI-D-authority': { granularity: '1d' },
}

// In-memory sliding-window rate limiter (resets on cold start; sufficient for v1)
const rlMap = new Map<string, { count: number; windowStart: number }>()

function checkRateLimit(bucket: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now()
  const windowMs = 60_000
  const entry = rlMap.get(bucket)
  if (!entry || now - entry.windowStart > windowMs) {
    rlMap.set(bucket, { count: 1, windowStart: now })
    return { allowed: true }
  }
  if (entry.count >= RATE_LIMIT_RPM) {
    const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000)
    return { allowed: false, retryAfter }
  }
  entry.count++
  return { allowed: true }
}

async function hashKey(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function errResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: code, message }, { status })
}

interface RateItem {
  asset: string
  fiat: string
  at: string
  product?: string
}

// ISO-8601 UTC: requires Z suffix only.
// Offset timestamps (e.g. 2026-07-01T12:00:00+05:00) return 400; callers must
// normalize to UTC before calling. Bare dates and local-time strings without a
// timezone marker are also rejected.
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

// Caller surface and non-200 behavior (required for Auditor sign-off):
//
// Callers:
//   1. External ORBI API consumers holding orbi_api_keys, calling this
//      endpoint directly.
//   2. workers/api-gateway (this repo): routes GET /v1/rate and POST /v1/rate
//      to this function via proxyToSupabase, which returns fetch(upstream)
//      verbatim without inspecting or rewriting the status. Any non-200
//      response from this function (including 502) reaches the end consumer
//      unchanged.
//
//   400/401/405/429/503 -- handler returns structured JSON { error, message };
//     callers act per code (retry 429 with Retry-After, fix request on 4xx,
//     back off on 503).
//   500 -- outer try/catch (below) returns structured JSON
//     { error: 'server_error', message, correlation_id }; callers treat as
//     transient and may retry.
//   502 -- wrapSentryHandler catches any exception that escapes the outer
//     catch, reports it to GlitchTip, then re-throws; Supabase edge runtime
//     converts the unhandled throw into 502 Bad Gateway. This fires only for
//     true programming bugs or fatal init failures after module load. Callers
//     receive a raw Supabase 502 body (no structured JSON); the api-gateway
//     forwards this verbatim to the end consumer. Treat 502 as a transient
//     outage and retry with exponential backoff.
Deno.serve(wrapSentryHandler(async (req: Request) => {
  const correlationId = crypto.randomUUID()
  try {
  // ----- Feature flag -----
  // Require explicit "true"; "false", "0", or unset all disable the endpoint.
  if (Deno.env.get('ORBI_RATE_API_ENABLED') !== 'true') return errResponse(503, 'not_enabled', 'endpoint not active')

  // ----- Auth -----
  const authHeader = req.headers.get('Authorization') ?? req.headers.get('x-api-key') ?? ''
  if (!authHeader) return errResponse(401, 'missing_key', 'Authorization header required')
  const rawKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const keyHash = await hashKey(rawKey)

  // maybeSingle, not single: with single(), PostgREST reports zero matching rows
  // as an error, so an unknown or revoked key would land in the keyErr branch and
  // return 500. maybeSingle leaves keyErr for genuine database faults and returns
  // a null row for "no such key", which is the 401 below.
  const { data: keyRow, error: keyErr } = await supabase
    .from('orbi_api_keys')
    .select('consumer_id, key_prefix')
    .eq('key_hash', keyHash)
    .is('revoked_at', null)
    .maybeSingle()

  // DB-level error is an outage or misconfiguration, not an auth failure.
  // Return 500 so callers can distinguish unavailability from a bad key.
  if (keyErr) {
    console.error(`key-lookup DB error [${correlationId}]:`, keyErr)
    void reportError(keyErr, 'v1-rate', req)
    return Response.json({ error: 'server_error', message: 'Database error during key lookup', correlation_id: correlationId }, { status: 500 })
  }
  if (!keyRow) return errResponse(401, 'invalid_key', 'API key invalid or revoked')

  // ----- Rate limit (per consumer) -----
  // Bucket by consumer_id: always unique per consumer, format-independent.
  const rl = checkRateLimit(keyRow.consumer_id)
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({ error: 'rate_limited', message: 'Too many requests' }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(rl.retryAfter) } }
    )
  }

  // ----- Parse items -----
  let items: RateItem[] = []
  try {
    if (req.method === 'GET') {
      const u = new URL(req.url)
      const asset = u.searchParams.get('asset')
      const fiat = u.searchParams.get('fiat')
      const at = u.searchParams.get('at')
      const product = u.searchParams.get('product') ?? 'ORBI-M'
      if (!asset || !fiat || !at) return errResponse(400, 'bad_params', 'asset, fiat, at required')
      items = [{ asset, fiat, at, product }]
    } else if (req.method === 'POST') {
      const body = await req.json()
      // Reject null, primitives, and other non-object bodies before iterating.
      if (body === null || typeof body !== 'object') {
        return errResponse(400, 'bad_body', 'Request body must be an object or array')
      }
      items = Array.isArray(body) ? body : [body]
    } else {
      return errResponse(405, 'method_not_allowed', 'GET or POST only')
    }
  } catch {
    return errResponse(400, 'bad_json', 'Invalid JSON body')
  }

  if (items.length === 0) return errResponse(400, 'empty_batch', 'No items provided')
  if (items.length > BATCH_LIMIT) return errResponse(400, 'batch_too_large', `Max batch is ${BATCH_LIMIT}`)

  for (const item of items) {
    // Guard against null or primitive elements inside an array body.
    if (item === null || typeof item !== 'object' || !item.asset || !item.fiat || !item.at) {
      return errResponse(400, 'bad_params', 'Each item requires asset, fiat, at')
    }
    if (!ISO_UTC_RE.test(item.at) || isNaN(new Date(item.at).getTime())) {
      return errResponse(400, 'bad_timestamp', `Timestamp must be ISO-8601 UTC with Z suffix (e.g. 2026-07-01T12:00:00Z): ${item.at}`)
    }
    const product = item.product ?? 'ORBI-M'
    // Object.hasOwn prevents inherited props (e.g. "toString") from bypassing the 400.
    if (!Object.hasOwn(VALID_PRODUCTS, product)) {
      return errResponse(400, 'bad_product', `product must be one of: ${Object.keys(VALID_PRODUCTS).join(', ')}`)
    }
  }

  // ----- Resolve rates -----
  const results = []
  const usageLogs = []

  for (const item of items) {
    const product = item.product ?? 'ORBI-M'
    const { granularity } = VALID_PRODUCTS[product]

    // Truncate timestamp to the bucket boundary for this granularity
    const ts = new Date(item.at)
    if (granularity === '1m') {
      ts.setSeconds(0, 0)
    } else {
      // 1d: truncate to UTC midnight
      ts.setUTCHours(0, 0, 0, 0)
    }
    const bucketTs = ts.toISOString()

    // All five equality filters are required to fire idx_rates_lookup end-to-end:
    //   (source_currency, target_currency, granularity, product, bucket_ts DESC)
    // source_authority='ORBI', status='CONFIRMED', superseded_by_id IS NULL
    // ensure we return only current, authoritative rows.
    // rate is numeric(20,8). Select it as `rate::text` so PostgREST emits it
    // as a JSON string, not a bare JSON number. A bare number is parsed by
    // supabase-js through a float64 before our code ever sees it, which
    // silently truncates high-magnitude rates (e.g. a value needing more than
    // 15-16 significant digits). Keeping it a string preserves every digit end
    // to end. Do NOT drop the ::text cast, and do NOT wrap row.rate in
    // String(...) instead: by that point the value is already the lossy float.
    // PostgREST select syntax has no AS; a bare cast keeps the field name `rate`.
    const { data: row, error: rateErr } = await supabase
      .from('exchange_rates')
      .select('bucket_ts, rate::text, provenance, tier, source_authority')
      .eq('source_currency', item.asset.toUpperCase())
      .eq('target_currency', item.fiat.toUpperCase())
      .eq('granularity', granularity)
      .eq('product', product)
      .eq('source_authority', 'ORBI')
      .eq('status', 'CONFIRMED')
      .is('superseded_by_id', null)
      .lte('bucket_ts', bucketTs)
      .order('bucket_ts', { ascending: false })
      .limit(1)
      .maybeSingle()

    // A query error means the database is unavailable or misconfigured.
    // Return 500 so callers can distinguish DB-down from legitimate no-data.
    if (rateErr) {
      console.error(`rate-lookup DB error [${correlationId}]:`, rateErr, JSON.stringify({ asset: item.asset, fiat: item.fiat, product, granularity, bucketTs }))
      void reportError(rateErr, 'v1-rate', req)
      return Response.json({ error: 'server_error', message: 'Database error fetching exchange rate', correlation_id: correlationId }, { status: 500 })
    }

    const resolvedTs = row ? new Date(row.bucket_ts).toISOString() : bucketTs
    const fillType = !row ? 'gap' : resolvedTs === bucketTs ? 'exact' : 'forward_fill'

    results.push({
      asset: item.asset.toUpperCase(),
      fiat: item.fiat.toUpperCase(),
      product,
      requested_at: item.at,
      resolved_at: resolvedTs,
      rate: row?.rate ?? null,
      provenance: row?.provenance ?? null,
      tier: row?.tier ?? null,
      source_authority: row?.source_authority ?? null,
      fill_type: fillType
    })

    usageLogs.push({
      consumer_id: keyRow.consumer_id,
      key_prefix: keyRow.key_prefix,
      asset: item.asset.toUpperCase(),
      fiat: item.fiat.toUpperCase(),
      requested_at: item.at,
      fill_type: fillType,
      batch_size: items.length,
      http_status: 200
    })
  }

  // Await so metering actually writes; failure is non-fatal and must not block the response.
  const { error: logErr } = await supabase.from('orbi_usage_log').insert(usageLogs)
  if (logErr) console.error('usage-log insert failed:', logErr.message)

  return Response.json(items.length === 1 ? results[0] : { results, count: results.length })
  } catch (err) {
    console.error(`v1-rate unhandled error [${correlationId}]:`, err)
    void reportError(err, 'v1-rate', req)
    return Response.json({ error: 'server_error', message: 'Internal error', correlation_id: correlationId }, { status: 500 })
  }
}, 'v1-rate'))
