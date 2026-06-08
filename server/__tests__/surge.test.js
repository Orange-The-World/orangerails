// End-to-end test for the Surge adapter against the mock.
// Run: node --test server/__tests__/surge.test.js
// Zero new dependencies — uses node:test + node:http.

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const mockApp = require('../mocks/surge-mock')

const OWNER = '0xf3fE9fa2F90D18937A5f0c824BAfB612f215FB1c'

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

test('GET /partner/me echoes token metadata', async () => {
  const me = await adapter.me('mock_good')
  assert.equal(me.partner, 'bitbook')
  assert.ok(me.scope.includes('positions.read'))
  assert.equal(me.owner.toLowerCase(), OWNER.toLowerCase())
})

test('GET /owners/:owner/positions returns normalized positions', async () => {
  const { positions, meta } = await adapter.positions(OWNER, 'mock_good')
  assert.equal(positions.length, 2)
  assert.equal(meta.chain_id, 84532)
  const active = positions.find((p) => p.status === 'active')
  assert.equal(active.id, '226')
  assert.equal(active.collateral.asset, 'BTC')
  assert.equal(active.debt.asset, 'USDC')
  assert.equal(active.rate.apr_bps, 597)
  assert.ok(active.raw)
})

test('GET /owners/:owner/summary returns aggregate', async () => {
  const s = await adapter.summary(OWNER, 'mock_good')
  assert.equal(s.position_count, 2)
  assert.equal(s.active_position_count, 1)
  assert.equal(s.data_quality.accrued_interest_available, false)
})

test('GET /owners/:owner/accounting-state buckets into pledged + LOC', async () => {
  const a = await adapter.accountingState(OWNER, 'mock_good')
  assert.equal(
    a.positions[0].accounts.pledged_btc.account_name,
    'Bitcoin, Pledged to Surge'
  )
  assert.equal(
    a.positions[0].accounts.line_of_credit.account_name,
    'Surge Line of Credit'
  )
})

test('GET /owners/:owner/events returns desc-ordered actions', async () => {
  const { events, meta } = await adapter.events(OWNER, 'mock_good', { limit: 3 })
  assert.equal(events.length, 3)
  assert.equal(meta.order, 'desc')
  const actions = events.map((e) => e.action)
  for (const expected of ['borrowed', 'collateral_added', 'loan_opened']) {
    assert.ok(actions.includes(expected), `missing action: ${expected}`)
  }
})

test('error path: auth_token_revoked', async () => {
  await assert.rejects(
    adapter.positions(OWNER, 'mock_revoked'),
    (err) => err.code === 'auth_token_revoked' && err.status === 401
  )
})

test('error path: auth_owner_mismatch', async () => {
  await assert.rejects(
    adapter.positions(OWNER, 'mock_wrong_owner'),
    (err) => err.code === 'auth_owner_mismatch' && err.status === 403
  )
})

test('error path: auth_token_malformed', async () => {
  await assert.rejects(
    adapter.positions(OWNER, 'gibberish'),
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
  const res = await fetch(`${base}/owners/${OWNER}/positions`)
  assert.equal(res.status, 401)
  const body = await res.json()
  assert.equal(body.error.code, 'auth_header_missing')
})
