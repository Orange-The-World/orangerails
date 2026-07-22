// supabase/functions/v1-rate/index.ts
// ORBI Point-in-Time Rate API v1
// Authored: ORBI agent, 2026-07-22

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const RATE_LIMIT_RPM = parseInt(Deno.env.get('RATE_LIMIT_RPM') ?? '60')
const BATCH_LIMIT = parseInt(Deno.env.get('BATCH_LIMIT') ?? '50')

// In-memory sliding-window rate limiter (resets on cold start; sufficient for v1)
const rlMap = new Map<string, { count: number; windowStart: number }>()

function checkRateLimit(keyPrefix: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now()
  const windowMs = 60_000
  const entry = rlMap.get(keyPrefix)
  if (!entry || now - entry.windowStart > windowMs) {
    rlMap.set(keyPrefix, { count: 1, windowStart: now })
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
}

Deno.serve(async (req: Request) => {
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

  if (keyErr || !keyRow) return errResponse(401, 'invalid_key', 'API key invalid or revoked')

  // ----- Rate limit -----
  const rl = checkRateLimit(keyRow.key_prefix)
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
      if (!asset || !fiat || !at) return errResponse(400, 'bad_params', 'asset, fiat, at required')
      items = [{ asset, fiat, at }]
    } else if (req.method === 'POST') {
      const body = await req.json()
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
    if (!item.asset || !item.fiat || !item.at) {
      return errResponse(400, 'bad_params', 'Each item requires asset, fiat, at')
    }
    if (isNaN(new Date(item.at).getTime())) {
      return errResponse(400, 'bad_timestamp', `Invalid ISO-8601 timestamp: ${item.at}`)
    }
  }

  // ----- Resolve rates -----
  const results = []
  const usageLogs = []

  for (const item of items) {
    const ts = new Date(item.at)
    ts.setSeconds(0, 0)
    const bucketTs = ts.toISOString()

    // UNKNOWN: confirm whether a `product` filter is required here.
    // The index idx_rates_lookup covers (source_currency, target_currency, granularity, product, bucket_ts DESC).
    // If multiple product values exist for granularity='1m', add: .eq('product', 'ORBI-1m')
    // @DBA: please confirm the product value for 1m rows before this ships.
    const { data: row } = await supabase
      .from('exchange_rates')
      .select('bucket_ts, rate, provenance, tier, source_authority')
      .eq('source_currency', item.asset.toUpperCase())
      .eq('target_currency', item.fiat.toUpperCase())
      .eq('granularity', '1m')
      .lte('bucket_ts', bucketTs)
      .order('bucket_ts', { ascending: false })
      .limit(1)
      .maybeSingle()

    const resolvedTs = row ? new Date(row.bucket_ts).toISOString() : bucketTs
    const fillType = !row ? 'gap' : resolvedTs === bucketTs ? 'exact' : 'forward_fill'

    results.push({
      asset: item.asset.toUpperCase(),
      fiat: item.fiat.toUpperCase(),
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

  // Fire-and-forget usage log (batch insert)
  supabase.from('orbi_usage_log').insert(usageLogs)

  return Response.json(items.length === 1 ? results[0] : { results, count: results.length })
})
