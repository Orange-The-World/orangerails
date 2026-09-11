// supabase/functions/v1-rates-latest/index.ts
// ORBI API v2: GET /v1/rates/latest
// Authored: Sr. Developer, 2026-09-06 -- OR-T2518, spec OR-T2437 item 2
//
// Returns the most recent CONFIRMED, non-superseded rate for a base/quote
// pair: the row with the greatest bucket_ts where status = 'CONFIRMED' and
// superseded_by_id is null. Auth, rate limiting and error shapes are
// reused from v1-rate exactly, per spec section "Error codes".

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0'
import { wrapSentryHandler, reportError } from '../_shared/sentry.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const RATE_LIMIT_RPM = parseInt(Deno.env.get('RATE_LIMIT_RPM') ?? '60')

// Fiat set used to infer a default product when the caller does not pass one.
// Central-bank-quoted fiat pairs are served on ORBI-D-authority (1d); every
// other pair (crypto, or a fiat leg ORBI does not carry as an authority pair)
// defaults to ORBI-M (1m). This mirrors the product registry in v1-rate but
// v1-rate itself does not show inference code, so this default is new here
// and should be confirmed with ORBI if a caller needs different behavior.
const FIAT_CODES = new Set(['USD', 'EUR', 'GBP', 'AUD', 'CAD'])
function inferProduct(base: string, quote: string): string {
  return FIAT_CODES.has(base) && FIAT_CODES.has(quote) ? 'ORBI-D-authority' : 'ORBI-M'
}

function errResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: code, message }, { status })
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

interface LatestRow {
  bucket_ts: string
  rate: string
  provenance: string | null
  tier: string | null
  source_authority: string | null
}

// Fetch the single most recent CONFIRMED, non-superseded row for a direct pair.
async function fetchLatestDirect(
  supabase: ReturnType<typeof createClient>,
  base: string,
  quote: string,
  product: string,
  granularity: string,
): Promise<{ row: LatestRow | null; error: unknown }> {
  const { data, error } = await supabase
    .from('exchange_rates')
    .select('bucket_ts, rate::text, provenance, tier, source_authority')
    .eq('source_currency', base)
    .eq('target_currency', quote)
    .eq('granularity', granularity)
    .eq('product', product)
    .eq('source_authority', 'ORBI')
    .eq('status', 'CONFIRMED')
    .is('superseded_by_id', null)
    .order('bucket_ts', { ascending: false })
    .limit(1)
    .maybeSingle()
  return { row: data as LatestRow | null, error }
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
      void reportError(keyErr, 'v1-rates-latest', req)
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
    if (!baseParam || !quoteParam) return errResponse(400, 'bad_params', 'base and quote required')
    const base = baseParam.toUpperCase()
    const quote = quoteParam.toUpperCase()
    const product = (u.searchParams.get('product') ?? inferProduct(base, quote))
    const granularity = product === 'ORBI-M' ? '1m' : '1d'

    let httpStatus = 200
    let responseBody: Record<string, unknown>

    const direct = await fetchLatestDirect(supabase, base, quote, product, granularity)
    if (direct.error) {
      console.error(`rate-lookup DB error [${correlationId}]:`, direct.error)
      void reportError(direct.error, 'v1-rates-latest', req)
      return Response.json({ error: 'server_error', message: 'Database error fetching exchange rate', correlation_id: correlationId }, { status: 500 })
    }

    if (direct.row) {
      responseBody = {
        base, quote,
        bucket_ts: direct.row.bucket_ts,
        rate: direct.row.rate,
        fill_type: 'exact',
        provenance: direct.row.provenance ?? null,
        composite: false,
        composite_via: null,
        tier: direct.row.tier ?? null,
        source_authority: direct.row.source_authority ?? null,
      }
    } else if (product === 'ORBI-D-authority' && FIAT_CODES.has(base) && FIAT_CODES.has(quote) && base !== 'USD' && quote !== 'USD') {
      // No direct row for a fiat/fiat pair: triangulate via USD, per spec
      // section 5. rate(base,quote) = rate(USD,quote) / rate(USD,base).
      const [viaQuote, viaBase] = await Promise.all([
        fetchLatestDirect(supabase, 'USD', quote, product, granularity),
        fetchLatestDirect(supabase, 'USD', base, product, granularity),
      ])
      if (viaQuote.error || viaBase.error) {
        console.error(`composite lookup DB error [${correlationId}]:`, viaQuote.error, viaBase.error)
        void reportError(viaQuote.error ?? viaBase.error, 'v1-rates-latest', req)
        return Response.json({ error: 'server_error', message: 'Database error fetching composite exchange rate', correlation_id: correlationId }, { status: 500 })
      }
      if (!viaQuote.row || !viaBase.row) {
        httpStatus = 404
        responseBody = { error: 'unsupported_pair', message: `No rate coverage for ${base}/${quote} on product ${product} (direct or via USD)` }
      } else {
        const rate = Number(viaQuote.row.rate) / Number(viaBase.row.rate)
        const olderTs = new Date(viaQuote.row.bucket_ts) < new Date(viaBase.row.bucket_ts) ? viaQuote.row.bucket_ts : viaBase.row.bucket_ts
        responseBody = {
          base, quote,
          bucket_ts: olderTs,
          rate: String(rate),
          fill_type: 'exact',
          provenance: null,
          composite: true,
          composite_via: 'USD',
          tier: null,
          source_authority: 'ORBI',
        }
      }
    } else {
      httpStatus = 404
      responseBody = { error: 'unsupported_pair', message: `No rate coverage for ${base}/${quote} on product ${product}` }
    }

    const { error: logErr } = await supabase.from('orbi_usage_log').insert([{
      consumer_id: keyRow.consumer_id,
      key_prefix: keyRow.key_prefix,
      endpoint: 'v1-rates-latest',
      base, quote, product,
      http_status: httpStatus,
    }])
    if (logErr) console.error('usage-log insert failed:', logErr.message)

    return Response.json(responseBody, { status: httpStatus })
  } catch (err) {
    console.error(`v1-rates-latest unhandled error [${correlationId}]:`, err)
    void reportError(err, 'v1-rates-latest', req)
    return Response.json({ error: 'server_error', message: 'Internal error', correlation_id: correlationId }, { status: 500 })
  }
}, 'v1-rates-latest'))
