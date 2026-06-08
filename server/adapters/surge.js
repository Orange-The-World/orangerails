// Surge Partner API adapter.
// Spec: https://wiki.abascal.ca/doc/surge-Od9bf1GgpE
//
// Auth model: the customer pastes a base64url envelope into Orange Rails.
// The token already binds to (owner, partner, scope, env) and is verified
// by the Surge backend on every call. Orange Rails never inspects the token.
//
// Base URL is env-driven so dev can point at the mock server in
// server/mocks/surge-mock.js.

const SURGE_API_BASE =
  process.env.SURGE_API_BASE || 'https://api.testnet.surge.credit/api/v1'

async function req(path, token, fetchImpl = fetch) {
  const res = await fetchImpl(`${SURGE_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'OrangeRails/0.1 (+integrations@bitbooks.com)'
    }
  })
  let body = null
  try { body = await res.json() } catch (_) { /* tolerate non-JSON */ }
  if (!res.ok || !body || body.success !== true) {
    const code = body && body.error && body.error.code
      ? body.error.code
      : `http_${res.status}`
    const message = body && body.error && body.error.message
      ? body.error.message
      : `Surge HTTP ${res.status}`
    const err = new Error(message)
    err.code = code
    err.status = res.status
    throw err
  }
  return body
}

async function positions(owner, token, fetchImpl) {
  const body = await req(`/owners/${owner}/positions`, token, fetchImpl)
  return {
    positions: body.data.map(normalizePosition),
    meta: body.meta
  }
}

async function summary(owner, token, fetchImpl) {
  const body = await req(`/owners/${owner}/summary`, token, fetchImpl)
  return body.data
}

async function accountingState(owner, token, fetchImpl) {
  const body = await req(`/owners/${owner}/accounting-state`, token, fetchImpl)
  return body.data
}

async function events(owner, token, opts = {}, fetchImpl) {
  const limit = opts.limit ?? 50
  const raw = opts.raw ? 1 : 0
  const qs = `limit=${limit}&raw=${raw}`
  const body = await req(`/owners/${owner}/events?${qs}`, token, fetchImpl)
  return { events: body.data, meta: body.meta }
}

async function me(token, fetchImpl) {
  const body = await req('/partner/me', token, fetchImpl)
  return body.data
}

async function health(fetchImpl = fetch) {
  const res = await fetchImpl(`${SURGE_API_BASE}/health`)
  return res.json()
}

// Normalize a Surge position into the shape Orange Rails uses internally.
// Keep the raw payload attached so journal-entry derivation can fall back
// to fields we don't surface yet (e.g. vault_address once Phase 2 ships).
function normalizePosition(p) {
  return {
    id: p.position_id,
    adapter: 'surge',
    chain_id: p.chain_id,
    owner_address: p.owner_address,
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
  _base: () => SURGE_API_BASE
}
