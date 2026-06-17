// Mock Surge Partner API.
// Implements the documented JSON shapes so the Orange Rails connector can be
// built against the spec before the real testnet sandbox is wired up.
//
// Run standalone:   node server/mocks/surge-mock.js     (defaults to :3099)
// Use in tests:     const app = require('./mocks/surge-mock'); supertest(app)...
//
// Token shortcuts (since we don't verify EIP-191 signatures in the mock):
//   mock_good          → owner = 0xf3fE...215FB1c, all routes succeed
//   mock_revoked       → 401 auth_token_revoked
//   mock_wrong_owner   → 403 auth_owner_mismatch (token owner = 0x0000...)
//   mock_unknown       → 401 auth_token_malformed
//
// Override the test owner with TEST_OWNER env var if needed.

const express = require('express')
const path = require('path')

const POSITIONS = require('./fixtures/surge-positions.json')
const SUMMARY = require('./fixtures/surge-summary.json')
const ACCT = require('./fixtures/surge-accounting-state.json')
const EVENTS = require('./fixtures/surge-events.json')

const TEST_OWNER = (process.env.TEST_OWNER ||
  '0xf3fE9fa2F90D18937A5f0c824BAfB612f215FB1c').toLowerCase()

function errorRes(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } })
}

function authGate(req, res, next) {
  const h = req.headers.authorization || ''
  if (!h.startsWith('Bearer ')) {
    return errorRes(res, 401, 'auth_header_missing',
      'No Authorization header or wrong scheme')
  }
  const token = h.slice(7)
  if (token === 'mock_revoked') {
    return errorRes(res, 401, 'auth_token_revoked', 'Nonce in revocation table')
  }
  if (token === 'mock_wrong_owner') {
    req.tokenOwner = '0x0000000000000000000000000000000000000000'
  } else if (token === 'mock_good') {
    req.tokenOwner = TEST_OWNER
  } else {
    return errorRes(res, 401, 'auth_token_malformed',
      'Token not recognized by mock server (use mock_good / mock_revoked / mock_wrong_owner)')
  }
  next()
}

function ownerGuard(req, res) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(req.params.owner)) {
    errorRes(res, 400, 'invalid_address',
      ':owner is not a 0x-prefixed 40-hex address')
    return true
  }
  if (req.params.owner.toLowerCase() !== req.tokenOwner.toLowerCase()) {
    errorRes(res, 403, 'auth_owner_mismatch',
      'Token owner does not match URL owner')
    return true
  }
  return false
}

const app = express()
app.use(express.json())

app.get('/api/v1/health', (req, res) => {
  res.json({ success: true, status: 'ok', version: 'v1' })
})

app.get('/api/v1/partner/me', authGate, (req, res) => {
  res.json({
    success: true,
    data: {
      owner: req.tokenOwner,
      partner: 'bitbook',
      scope: ['positions.read', 'summary.read', 'accounting.read', 'events.read'],
      environment: 'testnet',
      chain_id: 84532
    }
  })
})

app.get('/api/v1/owners/:owner/positions', authGate, (req, res) => {
  if (ownerGuard(req, res)) return
  res.json(POSITIONS)
})

app.get('/api/v1/owners/:owner/summary', authGate, (req, res) => {
  if (ownerGuard(req, res)) return
  res.json(SUMMARY)
})

app.get('/api/v1/owners/:owner/accounting-state', authGate, (req, res) => {
  if (ownerGuard(req, res)) return
  res.json(ACCT)
})

app.get('/api/v1/owners/:owner/events', authGate, (req, res) => {
  if (ownerGuard(req, res)) return
  const limit = Math.min(Number(req.query.limit ?? 50), 250)
  const raw = req.query.raw === '1'
  const sliced = EVENTS.data.slice(0, limit)
  res.json({
    ...EVENTS,
    data: sliced,
    meta: { ...EVENTS.meta, count: sliced.length, include_raw: raw }
  })
})

app.use((req, res) => errorRes(res, 404, 'bad_request',
  `Unknown route ${req.method} ${req.path}`))

if (require.main === module) {
  const PORT = process.env.SURGE_MOCK_PORT || 3099
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Mock Surge API ready: http://localhost:${PORT}/api/v1`)
    console.log(`  health:        curl http://localhost:${PORT}/api/v1/health`)
    console.log(`  positions:     curl -H "Authorization: Bearer mock_good" \\`)
    console.log(`                   http://localhost:${PORT}/api/v1/owners/${TEST_OWNER}/positions`)
  })
}

module.exports = app
