// Surge Partner API adapter (v1.1).
// Spec: https://maintainer-only(maintainer-only docs)
// OpenAPI: docs/openapi.yaml (delivered 2026-06-17 with sandbox token)
//
// Auth model: the borrower signs a canonical EIP-191 personal_sign message
// with the EVM wallet that owns their Surge position NFT. The signature and
// claims are packaged into a base64url(JSON) envelope — the bearer token.
// The Surge backend rebuilds the canonical message from the envelope and
// ecrecovers the signer on every request; the recovered address must equal
// the token's `borrower`, which must equal the `:borrower` in the URL.
//
// Orange Rails never inspects, signs, or rotates the token. We carry it.
// Base URL is env-driven so dev can point at the mock in
// server/mocks/surge-mock.js.

const SURGE_API_BASE =
  process.env.SURGE_API_BASE || 'https://test.partner.api.surge.dev/api/v1'

// Stable error vocabulary from the OpenAPI ErrorResponse enum.
// Downstream callers switch on these — never on `error.message`.
const ERROR_CODES = Object.freeze({
  BAD_REQUEST: 'bad_request',
  INVALID_ADDRESS: 'invalid_address',
  AUTH_HEADER_MISSING: 'auth_header_missing',
  AUTH_TOKEN_MALFORMED: 'auth_token_malformed',
  AUTH_SIGNATURE_INVALID: 'auth_signature_invalid',
  AUTH_TOKEN_REVOKED: 'auth_token_revoked',
  AUTH_BORROWER_MISMATCH: 'auth_borrower_mismatch',
  AUTH_PARTNER_UNKNOWN: 'auth_partner_unknown',
  AUTH_ENV_MISMATCH: 'auth_env_mismatch',
  AUTH_SCOPE_INSUFFICIENT: 'auth_scope_insufficient',
  BORROWER_NOT_FOUND: 'borrower_not_found',
  RATE_LIMITED: 'rate_limited',
  INTERNAL_ERROR: 'internal_error',
  UPSTREAM_UNAVAILABLE: 'upstream_unavailable'
})

const RETRYABLE = new Set([
  ERROR_CODES.UPSTREAM_UNAVAILABLE,
  ERROR_CODES.RATE_LIMITED,
  ERROR_CODES.INTERNAL_ERROR
])

class SurgeError extends Error {
  constructor({ code, message, status, retryAfter }) {
    super(message)
    this.name = 'SurgeError'
    this.code = code
    this.status = status
    this.retryAfter = retryAfter ?? null
    this.retryable = RETRYABLE.has(code)
  }
}

async function req(path, token, fetchImpl = fetch) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'OrangeRails/0.2 (noreply@orangerails.com)'
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetchImpl(`${SURGE_API_BASE}${path}`, { headers })
  let body = null
  try { body = await res.json() } catch (_) { /* tolerate non-JSON */ }

  if (!res.ok || !body || body.success !== true) {
    const code = body && body.error && body.error.code
      ? body.error.code
      : `http_${res.status}`
    const message = body && body.error && body.error.message
      ? body.error.message
      : `Surge HTTP ${res.status}`
    const retryAfterHeader = res.headers.get('retry-after')
    const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : null
    throw new SurgeError({ code, message, status: res.status, retryAfter })
  }
  return body
}

async function positions(borrower, token, fetchImpl) {
  const body = await req(`/borrowers/${borrower}/positions`, token, fetchImpl)
  return {
    positions: body.data.map(normalizePosition),
    meta: body.meta
  }
}

async function summary(borrower, token, fetchImpl) {
  const body = await req(`/borrowers/${borrower}/summary`, token, fetchImpl)
  return body.data
}

async function accountingState(borrower, token, fetchImpl) {
  const body = await req(`/borrowers/${borrower}/accounting-state`, token, fetchImpl)
  return body.data
}

async function events(borrower, token, opts = {}, fetchImpl) {
  const limit = opts.limit ?? 50
  const raw = opts.raw ? 1 : 0
  const qs = `limit=${limit}&raw=${raw}`
  const body = await req(`/borrowers/${borrower}/events?${qs}`, token, fetchImpl)
  return { events: body.data, meta: body.meta }
}

// Token introspection. A 200 here means the borrower's token is fully valid
// against the live backend — use this to flip the connector UI to "Connected"
// before showing any data, instead of guessing from a data-fetch result.
async function me(token, fetchImpl) {
  const body = await req('/partner/me', token, fetchImpl)
  return body.data
}

// Liveness probe. No auth; cheap to poll.
async function health(fetchImpl = fetch) {
  const res = await fetchImpl(`${SURGE_API_BASE}/health`)
  return res.json()
}

// Normalize a Surge position into the shape Orange Rails uses internally.
// Keep the raw payload attached so journal-entry derivation can fall back
// to fields we don't surface (e.g. vault_address once Phase 2 ships P2TR
// vault history).
function normalizePosition(p) {
  return {
    id: p.position_id,
    nft_id: p.nft_id,
    adapter: 'surge',
    chain_id: p.chain_id,
    borrower_address: p.borrower_address,
    market_id: p.market_id,
    status: p.status,
    collateral: {
      asset: p.collateral_asset,
      sats: p.collateral_sats != null ? String(p.collateral_sats) : null,
      btc: p.collateral_btc,
      vault_address: p.vault_address
    },
    debt: {
      asset: p.debt_asset,
      principal_atomic: p.principal_usdc != null ? String(p.principal_usdc) : null,
      principal_amount: p.principal_usdc_amount,
      accrued_interest_atomic: p.accrued_interest_usdc
    },
    rate: { type: p.rate_type, apr_bps: p.rate_apr_bps },
    risk: {
      ltv_bps: p.ltv_bps,
      liquidation_threshold_bps: p.liquidation_threshold_bps
    },
    timing: {
      last_settlement_at: p.last_settlement_at,
      last_position_update_at: p.last_position_update_at
    },
    raw: p
  }
}

module.exports = {
  positions,
  summary,
  accountingState,
  events,
  me,
  health,
  normalizePosition,
  ERROR_CODES,
  SurgeError,
  _base: () => SURGE_API_BASE
}
