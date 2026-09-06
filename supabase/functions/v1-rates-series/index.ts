// supabase/functions/v1-rates-series/index.ts
// ORBI API v2: GET /v1/rates/series
// Authored: Sr. Developer, 2026-09-06 -- OR-T2518, spec OR-T2437 item 1

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0'
import { wrapSentryHandler, reportError } from '../_shared/sentry.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const RATE_LIMIT_RPM = parseInt(Deno.env.get('RATE_LIMIT_RPM') ?? '60')

const FIAT_CODES = new Set(['USD', 'EUR', 'GBP', 'AUD', 'CAD'])
function inferProduct(base: string, quote: string): string {
  return FIAT_CODES.has(base) && FIAT_CODES.has(quote) ? 'ORBI-D-authority' : 'ORBI-M'
}

const MAX_POINTS = 5000
// See PR/commit message: v1 limit on how much 1m data this endpoint will
// aggregate client-side for a single hourly-granularity call.
const MAX_MINUTE_ROWS = 10000
const PAGE_SIZE = 1000

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

function parseBoundary(raw: string): Date | null {
  if (!DATE_ONLY_RE.test(raw) && !ISO_UTC_RE.test(raw)) return null
  const d = new Date(raw)
  return isNaN(d.getTime()) ? null : d
}

function errResponse(status: number, code: string, message: string, extra?: Record<string, unknown>): Response {
  return Response.json({ error: code, message, ...extra }, { status })
}

async function hashKey(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

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

interface SeriesRow {
  bucket_ts: string
  rate: string
  provenance: string | null
}

// Page through exchange_rates for one currency pair/product/granularity,
// inclusive of [fromIso, toIso], up to `cap` rows, ordered ascending.
async function fetchSeries(
  supabase: ReturnType<typeof createClient>,
  base: string,
  quote: string,
  product: string,
  granularity: string,
  fromIso: string,
  toIso: string,
  cap: number,
): Promise<{ rows: SeriesRow[]; error: unknown }> {
  const rows: SeriesRow[] = []
  let offset = 0
  while (rows.length < cap) {
    const pageCap = Math.min(PAGE_SIZE, cap - rows.length)
    const { data, error } = await supabase
      .from('exchange_rates')
      .select('bucket_ts, rate::text, provenance')
      .eq('source_currency', base)
      .eq('target_currency', quote)
      .eq('granularity', granularity)
      .eq('product', product)
      .eq('source_authority', 'ORBI')
      .eq('status', 'CONFIRMED')
      .is('superseded_by_id', null)
      .gte('bucket_ts', fromIso)
      .lte('bucket_ts', toIso)
      .order('bucket_ts', { ascending: true })
      .range(offset, offset + pageCap - 1)
    if (error) return { rows, error }
    if (!data || data.length === 0) break
    rows.push(...(data as SeriesRow[]))
    if (data.length < pageCap) break
    offset += pageCap
  }
  return { rows, error: null }
}

Deno.serve(wrapSentryHandler(async (req: Request) => {
  const correlationId = crypto.randomUUID()
  try {
    if (Deno.env.get('ORBI_RATE_API_ENABLED') !== 'true') return errResponse(503, 'not_enabled', 'endpoint not active')
    if (req.method !== 'GET') return errResponse(405, 'method_not_allowed', 'GET only')

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
      .maybeSingle()

    if (keyErr) {
      console.error(`key-lookup DB error [${correlationId}]:`, keyErr)
      void reportError(keyErr, 'v1-rates-series', req)
      return Response.json({ error: 'server_error', message: 'Database error during key lookup', correlation_id: correlationId }, { status: 500 })
    }
    if (!keyRow) return errResponse(401, 'invalid_key', 'API key invalid or revoked')

    const rl = checkRateLimit(keyRow.consumer_id)
    if (!rl.allowed) {
      return new Response(
        JSON.stringify({ error: 'rate_limited', message: 'Too many requests' }),
        { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(rl.retryAfter) } },
      )
    }

    const u = new URL(req.url)
    const baseParam = u.searchParams.get('base')
    const quoteParam = u.searchParams.get('quote')
    const fromParam = u.searchParams.get('from')
    const toParam = u.searchParams.get('to')
    const granularityParam = u.searchParams.get('granularity')

    if (!baseParam || !quoteParam || !fromParam || !toParam || !granularityParam) {
      return errResponse(400, 'bad_range', 'base, quote, from, to, granularity are all required')
    }
    if (granularityParam !== 'daily' && granularityParam !== 'hourly') {
      return errResponse(400, 'bad_granularity', 'granularity must be daily or hourly')
    }
    const fromDate = parseBoundary(fromParam)
    const toDate = parseBoundary(toParam)
    if (!fromDate || !toDate) {
      return errResponse(400, 'bad_range', 'from/to must be ISO-8601 UTC dates or timestamps (Z suffix)')
    }
    if (fromDate.getTime() > toDate.getTime()) {
      return errResponse(400, 'bad_range', 'from must not be after to')
    }

    const base = baseParam.toUpperCase()
    const quote = quoteParam.toUpperCase()
    const product = u.searchParams.get('product') ?? inferProduct(base, quote)
    const isCrypto = product === 'ORBI-M'

    if (granularityParam === 'hourly' && !isCrypto) {
      return errResponse(400, 'bad_granularity', 'hourly is not available for fiat pairs, only daily')
    }

    const spanMs = toDate.getTime() - fromDate.getTime()
    if (granularityParam === 'daily') {
      const days = Math.floor(spanMs / 86_400_000) + 1
      if (days > MAX_POINTS) return errResponse(400, 'range_too_large', `Requested range exceeds the point cap for daily granularity`, { max_points: MAX_POINTS, requested_points: days })
    } else {
      const hours = Math.floor(spanMs / 3_600_000) + 1
      if (hours > MAX_POINTS) return errResponse(400, 'range_too_large', `Requested range exceeds the point cap for hourly granularity`, { max_points: MAX_POINTS, requested_points: hours })
      const estMinuteRows = Math.floor(spanMs / 60_000) + 1
      if (estMinuteRows > MAX_MINUTE_ROWS) {
        return errResponse(400, 'range_too_large', 'Requested hourly range exceeds this v1 endpoint\'s underlying-data aggregation limit', { max_minute_rows: MAX_MINUTE_ROWS, requested_minute_rows: estMinuteRows })
      }
    }

    const fromIso = fromDate.toISOString()
    const toIso = toDate.toISOString()
    let points: Array<Record<string, unknown>>
    let httpStatus = 200
    let errorBody: Record<string, unknown> | null = null

    if (granularityParam === 'daily') {
      const direct = await fetchSeries(supabase, base, quote, product, '1d', fromIso, toIso, MAX_POINTS)
      if (direct.error) {
        console.error(`series lookup DB error [${correlationId}]:`, direct.error)
        void reportError(direct.error, 'v1-rates-series', req)
        return Response.json({ error: 'server_error', message: 'Database error fetching rate series', correlation_id: correlationId }, { status: 500 })
      }
      if (direct.rows.length > 0) {
        points = direct.rows.map(r => ({ bucket_ts: r.bucket_ts, rate: r.rate, fill_type: 'exact', provenance: r.provenance ?? null, composite: false }))
      } else if (!isCrypto && FIAT_CODES.has(base) && FIAT_CODES.has(quote) && base !== 'USD' && quote !== 'USD') {
        // No direct daily rows: triangulate via USD, per spec section 5.
        const [viaQuote, viaBase] = await Promise.all([
          fetchSeries(supabase, 'USD', quote, product, '1d', fromIso, toIso, MAX_POINTS),
          fetchSeries(supabase, 'USD', base, product, '1d', fromIso, toIso, MAX_POINTS),
        ])
        if (viaQuote.error || viaBase.error) {
          console.error(`composite series DB error [${correlationId}]:`, viaQuote.error, viaBase.error)
          void reportError(viaQuote.error ?? viaBase.error, 'v1-rates-series', req)
          return Response.json({ error: 'server_error', message: 'Database error fetching composite rate series', correlation_id: correlationId }, { status: 500 })
        }
        const byTsBase = new Map(viaBase.rows.map(r => [r.bucket_ts, r]))
        points = []
        for (const qRow of viaQuote.rows) {
          const bRow = byTsBase.get(qRow.bucket_ts)
          if (!bRow) continue // only emit buckets present on both legs
          points.push({
            bucket_ts: qRow.bucket_ts,
            rate: String(Number(qRow.rate) / Number(bRow.rate)),
            fill_type: 'exact',
            provenance: null,
            composite: true,
            composite_via: 'USD',
          })
        }
      } else {
        points = []
      }
    } else {
      // hourly, crypto only (fiat hourly already refused above)
      const minuteRows = await fetchSeries(supabase, base, quote, product, '1m', fromIso, toIso, MAX_MINUTE_ROWS)
      if (minuteRows.error) {
        console.error(`series lookup DB error [${correlationId}]:`, minuteRows.error)
        void reportError(minuteRows.error, 'v1-rates-series', req)
        return Response.json({ error: 'server_error', message: 'Database error fetching rate series', correlation_id: correlationId }, { status: 500 })
      }
      // Downsample: last tick of each UTC hour.
      const byHour = new Map<string, SeriesRow>()
      for (const row of minuteRows.rows) {
        const hourKey = row.bucket_ts.slice(0, 13) // "YYYY-MM-DDTHH"
        const existing = byHour.get(hourKey)
        if (!existing || new Date(row.bucket_ts) > new Date(existing.bucket_ts)) byHour.set(hourKey, row)
      }
      points = Array.from(byHour.values())
        .sort((a, b) => a.bucket_ts.localeCompare(b.bucket_ts))
        .map(r => ({ bucket_ts: r.bucket_ts, rate: r.rate, fill_type: 'exact', provenance: r.provenance ?? null, composite: false }))
    }

    if (!errorBody && points.length === 0) {
      httpStatus = 404
      errorBody = { error: 'unsupported_pair', message: `No rate coverage for ${base}/${quote} on product ${product} in the requested range` }
    }

    // Cache-Control: immutable once the whole requested range is settled.
    const nowMs = Date.now()
    const settlementLagMs = isCrypto ? 5 * 60_000 : 2 * 86_400_000
    const fullyPast = toDate.getTime() < nowMs - settlementLagMs
    const cacheControl = fullyPast ? 'public, max-age=31536000, immutable' : 'public, max-age=60'

    const { error: logErr } = await supabase.from('orbi_usage_log').insert([{
      consumer_id: keyRow.consumer_id,
      key_prefix: keyRow.key_prefix,
      endpoint: 'v1-rates-series',
      base, quote, product,
      http_status: httpStatus,
    }])
    if (logErr) console.error('usage-log insert failed:', logErr.message)

    const headers = { 'Content-Type': 'application/json', 'Cache-Control': cacheControl }
    if (errorBody) return new Response(JSON.stringify(errorBody), { status: httpStatus, headers })

    return new Response(JSON.stringify({
      base, quote, granularity: granularityParam, product,
      count: points.length,
      requested_from: fromParam,
      requested_to: toParam,
      points,
    }), { status: 200, headers })
  } catch (err) {
    console.error(`v1-rates-series unhandled error [${correlationId}]:`, err)
    void reportError(err, 'v1-rates-series', req)
    return Response.json({ error: 'server_error', message: 'Internal error', correlation_id: correlationId }, { status: 500 })
  }
}, 'v1-rates-series'))
