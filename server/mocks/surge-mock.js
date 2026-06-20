// Mock Surge Partner API (matches OpenAPI v1.1, docs/openapi.yaml).
//
// Run standalone:   node server/mocks/surge-mock.js   (defaults to :3099)
// Use in tests:     const app = require('./mocks/surge-mock'); supertest(app)...
//
// Token shortcuts (we don't actually verify EIP-191 signatures in the mock):
//   mock_good             → borrower = 0xf3fE...215FB1c, all routes succeed
//   mock_revoked          → 401 auth_token_revoked
//   mock_wrong_borrower   → 403 auth_borrower_mismatch (token borrower = 0x0000...)
//   mock_indexer_down     → 502 upstream_unavailable on data routes (auth still OK)
//   mock_rate_limited     → 429 rate_limited (Retry-After: 30)
//   anything else         → 401 auth_token_malformed
//
// Override the test borrower with TEST_BORROWER env var if needed.

const express = require('express')

const POSITIONS = require('./fixtures/surge-positions.json')
const SUMMARY = require('./fixtures/surge-summary.json')
const ACCT = require('./fixtures/surge-accounting-state.json')
const EVENTS = require('./fixtures/surge-events.json')

const TEST_BORROWER = (process.env.TEST_BORROWER ||
  '0xf3fE9fa2F90D18937A5f0c824BAfB612f215FB1c').toLowerCase()

function errorRes(res, status, code, message, extraHeaders) {
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v)
  return res.status(status).json({ success: false, error: { code, message } })
}

function authGate(req, res, next) {
  const h = req.headers.authorization || ''
  if (!h.startsWith('Bearer ')) {
    return errorRes(res, 401, 'auth_header_missing',
      'No Authorization header or wrong scheme')
  }
  const token = h.slice(7)
  switch (token) {
    case 'mock_revoked':
      return errorRes(res, 401, 'auth_token_revoked', 'Nonce in revocation table')
    case 'mock_rate_limited':
      return errorRes(res, 429, 'rate_limited',
        'Rate limit hit: 60 req/min per partner per borrower',
        { 'Retry-After': '30' })
    case 'mock_wrong_borrower':
      req.tokenBorrower = '0x0000000000000000000000000000000000000000'
      req.tokenMode = 'wrong_borrower'
      break
    case 'mock_indexer_down':
      req.tokenBorrower = TEST_BORROWER
      req.tokenMode = 'indexer_down'
      break
    case 'mock_good':
      req.tokenBorrower = TEST_BORROWER
      req.tokenMode = 'good'
      break
    default:
      return errorRes(res, 401, 'auth_token_malformed',
        'Token not recognized by mock server (use mock_good / mock_revoked / mock_wrong_borrower / mock_indexer_down / mock_rate_limited)')
  }
  next()
}

function borrowerGuard(req, res) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(req.params.borrower)) {
    errorRes(res, 400, 'invalid_address',
      ':borrower is not a 0x-prefixed 40-hex address')
    return true
  }
  if (req.params.borrower.toLowerCase() !== req.tokenBorrower.toLowerCase()) {
    errorRes(res, 403, 'auth_borrower_mismatch',
      'Token borrower does not match URL borrower')
    return true
  }
  if (req.tokenMode === 'indexer_down') {
    errorRes(res, 502, 'upstream_unavailable', 'Indexer is unreachable')
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
  // Mock partner/me succeeds even for mock_indexer_down — the auth layer is
  // healthy in that case, only the data sources are out. Matches live spec:
  // /partner/me does not touch the indexer.
  res.json({
    success: true,
    data: {
      borrower: req.tokenBorrower,
      partner: 'bitbook',
      scope: 'positions.read,summary.read,accounting.read,events.read',
      env: 'testnet',
      chain_id: 84532,
      issued_at: 1716285600000
    }
  })
})

app.get('/api/v1/borrowers/:borrower/positions', authGate, (req, res) => {
  if (borrowerGuard(req, res)) return
  res.json(POSITIONS)
})

app.get('/api/v1/borrowers/:borrower/summary', authGate, (req, res) => {
  if (borrowerGuard(req, res)) return
  res.json(SUMMARY)
})

app.get('/api/v1/borrowers/:borrower/accounting-state', authGate, (req, res) => {
  if (borrowerGuard(req, res)) return
  res.json(ACCT)
})

app.get('/api/v1/borrowers/:borrower/events', authGate, (req, res) => {
  if (borrowerGuard(req, res)) return
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
    console.log(`                   http://localhost:${PORT}/api/v1/borrowers/${TEST_BORROWER}/positions`)
  })
}

module.exports = app
