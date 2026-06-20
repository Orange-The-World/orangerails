// End-to-end test for the Surge adapter against the mock.
// Run: node --test server/__tests__/surge.test.js
// Zero new dependencies — uses node:test + node:http.

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const mockApp = require('../mocks/surge-mock')

const BORROWER = '0xf3fE9fa2F90D18937A5f0c824BAfB612f215FB1c'

let server
let base
let adapter

before(async () => {
  await new Promise((resolve) => {
    server = http.createServer(mockApp).listen(0, resolve)
  })
  base = `http://127.0.0.1:${server.address().port}/api/v1`
  process.env.SURGE_API_BASE = base
  delete require.cache[require.resolve('../adapters/surge.js')]
  adapter = require('../adapters/surge.js')
})

after(() => new Promise((resolve) => server.close(resolve)))

test('GET /health requires no auth', async () => {
  const out = await adapter.health()
  assert.deepEqual(out, { success: true, status: 'ok', version: 'v1' })
})

test('GET /partner/me echoes v1.1 token metadata', async () => {
  const me = await adapter.me('mock_good')
  assert.equal(me.partner, 'bitbook')
  assert.ok(me.scope.includes('positions.read'))
  assert.equal(me.borrower.toLowerCase(), BORROWER.toLowerCase())
  assert.equal(me.env, 'testnet')
  assert.equal(me.chain_id, 84532)
  assert.equal(typeof me.issued_at, 'number')
})

test('GET /borrowers/:borrower/positions returns normalized positions', async () => {
  const { positions, meta } = await adapter.positions(BORROWER, 'mock_good')
  assert.equal(positions.length, 2)
  assert.equal(meta.chain_id, 84532)
  assert.equal(meta.borrower_address.toLowerCase(), BORROWER.toLowerCase())
  const active = positions.find((p) => p.status === 'active')
  assert.equal(active.id, '226')
  assert.equal(active.nft_id, 226)
  assert.equal(active.borrower_address.toLowerCase(), BORROWER.toLowerCase())
  assert.equal(active.collateral.asset, 'BTC')
  assert.equal(active.debt.asset, 'USDC')
  assert.equal(active.rate.apr_bps, 597)
  assert.ok(active.raw)
})

test('GET /borrowers/:borrower/summary returns aggregate with data_quality', async () => {
  const s = await adapter.summary(BORROWER, 'mock_good')
  assert.equal(s.position_count, 2)
  assert.equal(s.active_position_count, 1)
  assert.equal(s.data_quality.accrued_interest_available, false)
  assert.equal(s.data_quality.vault_address_available, false)
})

test('GET /borrowers/:borrower/accounting-state buckets into pledged + LOC', async () => {
  const a = await adapter.accountingState(BORROWER, 'mock_good')
  assert.equal(
    a.positions[0].accounts.pledged_btc.account_name,
    'Bitcoin, Pledged to Surge'
  )
  assert.equal(
    a.positions[0].accounts.line_of_credit.account_name,
    'Surge Line of Credit'
  )
})

test('GET /borrowers/:borrower/events returns desc-ordered actions', async () => {
  const { events, meta } = await adapter.events(BORROWER, 'mock_good', { limit: 3 })
  assert.equal(events.length, 3)
  assert.equal(meta.order, 'desc')
  const actions = events.map((e) => e.action)
  for (const expected of ['borrowed', 'collateral_added', 'loan_opened']) {
    assert.ok(actions.includes(expected), `missing action: ${expected}`)
  }
})

test('error path: auth_token_revoked', async () => {
  await assert.rejects(
    adapter.positions(BORROWER, 'mock_revoked'),
    (err) => err.code === 'auth_token_revoked' && err.status === 401
  )
})

test('error path: auth_borrower_mismatch', async () => {
  await assert.rejects(
    adapter.positions(BORROWER, 'mock_wrong_borrower'),
    (err) => err.code === 'auth_borrower_mismatch' && err.status === 403
  )
})

test('error path: auth_token_malformed', async () => {
  await assert.rejects(
    adapter.positions(BORROWER, 'gibberish'),
    (err) => err.code === 'auth_token_malformed' && err.status === 401
  )
})

test('error path: invalid_address', async () => {
  await assert.rejects(
    adapter.positions('not-an-address', 'mock_good'),
    (err) => err.code === 'invalid_address' && err.status === 400
  )
})

test('error path: auth_header_missing', async () => {
  const res = await fetch(`${base}/borrowers/${BORROWER}/positions`)
  assert.equal(res.status, 401)
  const body = await res.json()
  assert.equal(body.error.code, 'auth_header_missing')
})

test('error path: upstream_unavailable (indexer down) — retryable', async () => {
  await assert.rejects(
    adapter.positions(BORROWER, 'mock_indexer_down'),
    (err) => err.code === 'upstream_unavailable' &&
             err.status === 502 &&
             err.retryable === true
  )
})

test('error path: rate_limited — retryable, Retry-After surfaced', async () => {
  await assert.rejects(
    adapter.positions(BORROWER, 'mock_rate_limited'),
    (err) => err.code === 'rate_limited' &&
             err.status === 429 &&
             err.retryable === true &&
             err.retryAfter === 30
  )
})

test('exports stable ERROR_CODES vocabulary', async () => {
  const codes = adapter.ERROR_CODES
  for (const k of [
    'AUTH_HEADER_MISSING',
    'AUTH_TOKEN_REVOKED',
    'AUTH_BORROWER_MISMATCH',
    'UPSTREAM_UNAVAILABLE',
    'RATE_LIMITED',
    'INVALID_ADDRESS'
  ]) assert.ok(codes[k], `missing ${k}`)
  // Frozen so consumers can't mutate the vocabulary.
  assert.ok(Object.isFrozen(codes))
})

test('partner/me succeeds even when indexer is down (auth layer healthy)', async () => {
  const me = await adapter.me('mock_indexer_down')
  assert.equal(me.partner, 'bitbook')
})
