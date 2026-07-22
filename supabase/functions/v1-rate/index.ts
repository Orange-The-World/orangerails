// supabase/functions/v1-rate/index.ts
// ORBI Point-in-Time Rate API v1
// Authored: ORBI agent, 2026-07-22
// Updated: Dev 1, 2026-07-22 -- DBA index corrections: product param, authority/status/superseded filters
// Updated: Dev 1, 2026-07-22 -- Auditor fixes: gateway config, env flag gate
// Updated: Dev 1, 2026-07-22 -- Surface DB errors as 500; do not mask as fill_type:gap
// Updated: Dev 1, 2026-07-22 -- CTO fix: rate-limit bucket by 16-char prefix (unique per key), not 8-char orbi_sk_
// Updated: Dev 1, 2026-07-22 -- ORBI fix: rate-limit bucket by consumer_id (unique per consumer, format-independent)
// Updated: Dev 1, 2026-07-22 -- Codex P2: flag gate, key-err split, body validation, UTC enforcement, hasOwn, usage-log await

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

// ISO-8601 UTC timestamp regex: requires Z suffix, rejects bare dates and offset timestamps.
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/

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

Deno.serve(async (req: Request) => {
  // ----- Feature flag -----
  // Require explicit "true"; "false", "0", unset, or any other value disables the endpoint.
  if (Deno.env.get('ORBI_RATE_API_ENABLED') !== 'true') return errResponse(503, 'not_enabled', 'endpoint not active')

  // ----- Auth -----
  const authHeader = req.headers.get('Authorization') ?? req.headers.get('x-api-key') ?? ''
  if (!authHeader) return errResponse(401, 'missing_key', 'Authorization header required')
  const rawKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const keyHash = await hashKey(rawKey)

  const { data: keyRow, error: keyErr } = await supabase
    .from('orbi_api_keys')
    .select('consumer_id, key_prefix')
    .eq('key_hash', keyHash)
    .is('revoked_at', null)
    .single()

  // Distinguish a DB/network failure (5xx) from an unknown or revoked key (401).
  if (keyErr) return errResponse(500, 'server_error', 'Database error during key lookup')
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
      // Reject null, primitives, and bare arrays-of-primitives; body must be an object or array of objects.
      if (body === null || typeof body !== 'object') {
        return errResponse(400, 'bad_json', 'Body must be an object or array of objects')
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
    // Reject null elements and non-objects inside a batch array to avoid TypeError on field access.
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return errResponse(400, 'bad_json', 'Each item must be a non-null object')
    }
    if (!item.asset || !item.fiat || !item.at) {
      return errResponse(400, 'bad_params', 'Each item requires asset, fiat, at')
    }
    // Enforce ISO-8601 UTC: Z suffix required. Bare dates (03/15/2024) and offset timestamps (+05:00) return 400.
    if (typeof item.at !== 'string' || !ISO_UTC_RE.test(item.at) || isNaN(new Date(item.at).getTime())) {
      return errResponse(400, 'bad_timestamp', `Timestamp must be ISO-8601 UTC with Z suffix: ${item.at}`)
    }
    const product = item.product ?? 'ORBI-M'
    // Use Object.hasOwn to prevent inherited prototype properties (e.g. "toString") from bypassing this check.
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
    const { data: row, error: rateErr } = await supabase
      .from('exchange_rates')
      .select('bucket_ts, rate, provenance, tier, source_authority')
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
      return errResponse(500, 'server_error', 'Database error fetching exchange rate')
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

  // Await usage log so metering actually writes; DB failure stays non-fatal.
  try { await supabase.from('orbi_usage_log').insert(usageLogs) } catch { /* non-fatal */ }

  return Response.json(items.length === 1 ? results[0] : { results, count: results.length })
})
