#!/usr/bin/env node
/**
 * Reports how large the biggest per-owner dataset in production has grown, as a TIER NAME
 * ONLY, so that an agreed review point is noticed when it is crossed and not when someone
 * happens to look. Tracking ticket: OR-T1937.
 *
 * WHAT IT READS. One fixed SELECT through the Supabase Management API, the same route the
 * migration check in supabase-deploy.yml already uses. It returns counts only: the vault
 * rows, the encrypted transactions in total, how many of those the per-owner join accounts
 * for, the largest per-owner transaction count and the largest per-owner connection count.
 * It reads no id and no row content, and it never prints anything it read.
 *
 * WHAT IT PRINTS. This repository is public, so its Actions logs are public. The report is
 * a tier name plus NONE or PRESENT for vault owners, and it carries no digit. Exact numbers
 * are read on demand by a seat that holds a production read.
 *
 * TIERS, decided on the larger of the two per-owner counts:
 *   OK          below 400
 *   LOOK-AGAIN  400 or more. Informational and green. A tier that is already true every
 *               week would be permanent noise, and noise gets ignored.
 *   WARN        2,000 or more. Red.
 *   STOP        5,000 or more. Red.
 *   UNKNOWN     this could not tell. Red, and never a pass. An unreadable answer, an empty
 *               table and a join that no longer accounts for every row all land here and
 *               never in OK.
 *
 * EXIT CODES. Each way of not looking has its own code, because a check that could not look
 * and exited 0 is worse than no check. 1 is left to the runtime, which uses it for an
 * uncaught exception, and the workflow goes red on every non-zero code.
 *   0   OK or LOOK-AGAIN
 *   2   the self-test failed, so nothing else this script says can be trusted
 *   3   UNKNOWN
 *   20  WARN
 *   21  STOP
 *
 * MODES.
 *   --selftest  needs no secret and no network beyond loopback; drives every outcome, the
 *               red ones included, through the real --read command line
 *   --read      the real read; needs SUPABASE_ACCESS_TOKEN and SUPABASE_REF. SIMULATE_MAX_ROWS
 *               (optional) decides the tier on that number instead of the real one, so the
 *               alarm path can be watched going red. The real read still happens.
 */

import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const LOOK_AGAIN_AT = 400
const WARN_AT = 2000
const STOP_AT = 5000

const EXIT = { OK: 0, SELFTEST_FAILED: 2, UNKNOWN: 3, WARN: 20, STOP: 21 }
const EXIT_BY_TIER = {
  OK: EXIT.OK,
  'LOOK-AGAIN': EXIT.OK,
  WARN: EXIT.WARN,
  STOP: EXIT.STOP,
  UNKNOWN: EXIT.UNKNOWN,
}

const API_ROOT = 'https://api.supabase.com'
// The token goes to the real API or to the loopback stand-in the self-test starts, nowhere else.
const LOOPBACK_ROOT = /^http:\/\/127\.0\.0\.1:[0-9]{2,5}$/

// One fixed SELECT. Aggregates only: it returns no id and no row content.
const QUERY = [
  'with per_owner as (',
  '  select c.subaccount_id, count(*) as n',
  '  from public.encrypted_transactions et',
  '  join public.connections c on c.id = et.connection_id',
  '  group by c.subaccount_id',
  '), per_owner_conn as (',
  '  select subaccount_id, count(*) as n from public.connections group by subaccount_id',
  ')',
  'select',
  '  (select count(*) from public.user_vault_meta)::bigint as user_vault_rows,',
  '  (select count(*) from public.customer_vault_meta)::bigint as customer_vault_rows,',
  '  (select count(*) from public.encrypted_transactions)::bigint as tx_total,',
  '  coalesce((select sum(n) from per_owner), 0)::bigint as tx_attributed,',
  '  coalesce((select max(n) from per_owner), 0)::bigint as tx_max_owner,',
  '  coalesce((select max(n) from per_owner_conn), 0)::bigint as conn_max_owner',
].join('\n')

const FIELDS = [
  'user_vault_rows',
  'customer_vault_rows',
  'tx_total',
  'tx_attributed',
  'tx_max_owner',
  'conn_max_owner',
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// The decision. Pure functions, so the self-test drives the real code.
// ---------------------------------------------------------------------------

// A count is a non-negative whole number, sent either as a JSON number or as a string of
// digits (the platform sends some aggregate types as strings). Anything else is not a count.
function toCount(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }
  if (typeof value === 'string' && /^[0-9]{1,15}$/.test(value)) {
    return Number(value)
  }
  return null
}

function parseSnapshot(body) {
  if (!Array.isArray(body) || body.length !== 1) {
    return { error: 'the answer was not exactly one row of counts' }
  }
  const row = body[0]
  const value = {}
  for (const field of FIELDS) {
    const count = row && typeof row === 'object' ? toCount(row[field]) : null
    if (count === null) return { error: `the answer had no usable count for ${field}` }
    value[field] = count
  }
  return { value }
}

function tierFor(rows) {
  if (rows >= STOP_AT) return 'STOP'
  if (rows >= WARN_AT) return 'WARN'
  if (rows >= LOOK_AGAIN_AT) return 'LOOK-AGAIN'
  return 'OK'
}

// The checks before the tier come first on purpose: a number that cannot be trusted must
// never become OK. simulatedMax replaces the real count for a test run and is labelled.
function classify(snapshot, simulatedMax) {
  if (snapshot.tx_total === 0) {
    return {
      tier: 'UNKNOWN',
      reason: 'the transactions table read as empty, which is not reported as safely small',
    }
  }
  if (snapshot.tx_attributed !== snapshot.tx_total) {
    return {
      tier: 'UNKNOWN',
      reason:
        'the per-owner join accounts for a different number of rows than the table holds, so it no longer measures what it was written to measure',
    }
  }
  if (snapshot.tx_max_owner > snapshot.tx_total) {
    return { tier: 'UNKNOWN', reason: 'the largest per-owner count is larger than the table total' }
  }
  const simulated = simulatedMax !== null && simulatedMax !== undefined
  const real = Math.max(snapshot.tx_max_owner, snapshot.conn_max_owner)
  return {
    tier: tierFor(simulated ? simulatedMax : real),
    vaultOwners: snapshot.user_vault_rows + snapshot.customer_vault_rows > 0,
    simulated,
  }
}

// What may be printed. No count goes into a tier report, so no digit does either.
function render(result) {
  const lines = [`VAULT ROW-COUNT WATCH: ${result.tier}`]
  if (result.tier === 'UNKNOWN') {
    lines.push(`This run could not tell: ${result.reason}.`)
    lines.push('That is not a report that anything is small.')
    return lines.join('\n')
  }
  lines.push(`Vault owners: ${result.vaultOwners ? 'PRESENT' : 'NONE'}`)
  if (result.tier === 'LOOK-AGAIN') {
    lines.push('This tier is informational and does not turn the run red.')
  }
  if (result.simulated) {
    lines.push('SIMULATED: this tier was decided on a number supplied for a test, not on the real count.')
  }
  lines.push(
    'Exact numbers are read on demand by a seat that holds a production read. This log is public and carries tier names only.',
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Reading. The response body is never printed: on a refusal it is the one place a
// token-shaped string could surface in a public log.
// ---------------------------------------------------------------------------

async function readSnapshot({ root, ref, token, delayMs }) {
  const attempts = 3
  let last = 'no attempt was made'
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) await sleep(delayMs)
    let response
    try {
      response = await fetch(`${root}/v1/projects/${ref}/database/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: QUERY }),
        signal: AbortSignal.timeout(30000),
      })
    } catch (err) {
      const why = (err && err.cause && err.cause.code) || (err && err.name) || 'error'
      last = `the request did not complete (${why})`
      continue
    }
    const status = response.status
    if (status === 401 || status === 403) {
      return { error: `the Management API refused the token (HTTP ${status})` }
    }
    if (status === 429 || status >= 500) {
      last = `the Management API answered HTTP ${status}`
      continue
    }
    if (status < 200 || status >= 300) {
      return { error: `the Management API answered HTTP ${status}, which is not an answer to this question` }
    }
    let body
    try {
      body = JSON.parse(await response.text())
    } catch {
      return { error: 'the answer was not JSON' }
    }
    return parseSnapshot(body)
  }
  return { error: `${last}, after ${attempts} attempts` }
}

function announce(result) {
  const text = render(result)
  console.log(text)
  const label = result.simulated ? ' (SIMULATED test number)' : ''
  if (result.tier === 'UNKNOWN') {
    console.log(`::error::vault row-count watch could not tell: ${result.reason}`)
  } else if (result.tier === 'WARN' || result.tier === 'STOP') {
    console.log(`::error::vault row-count watch is at ${result.tier}${label}`)
  } else if (result.tier === 'LOOK-AGAIN') {
    console.log(`::notice::vault row-count watch is at LOOK-AGAIN, which is informational${label}`)
  }
  if (result.vaultOwners) console.log('::warning::vault owners are PRESENT in production')
  const stamp = new Date().toISOString()
  console.log(`checked at ${stamp}`)
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) {
    try {
      appendFileSync(summaryPath, `## Vault row-count watch\n\n\`\`\`\n${text}\n\`\`\`\n\nChecked at ${stamp}.\n`)
    } catch {
      // The report is already in the log. A summary that cannot be written must not change the verdict.
    }
  }
}

function finish(result) {
  announce(result)
  process.exit(EXIT_BY_TIER[result.tier])
}

async function read() {
  const unknown = (reason) => finish({ tier: 'UNKNOWN', reason })
  const root = process.env.SUPABASE_API_URL || API_ROOT
  if (root !== API_ROOT && !LOOPBACK_ROOT.test(root)) {
    return unknown('SUPABASE_API_URL named a host this is not allowed to send the token to')
  }
  const token = process.env.SUPABASE_ACCESS_TOKEN || ''
  if (!token) return unknown('no access token was available to this run')
  const ref = process.env.SUPABASE_REF || ''
  if (!/^[a-z]{20}$/.test(ref)) return unknown('SUPABASE_REF was not a project reference')

  const rawSimulated = (process.env.SIMULATE_MAX_ROWS || '').trim()
  let simulated = null
  if (rawSimulated !== '') {
    simulated = toCount(rawSimulated)
    if (simulated === null) return unknown('the test number supplied was not a count')
  }

  const delayMs = toCount(process.env.RETRY_DELAY_MS || '') ?? 10000
  const got = await readSnapshot({ root, ref, token, delayMs })
  if (got.error) return unknown(got.error)
  return finish(classify(got.value, simulated))
}

// ---------------------------------------------------------------------------
// Self-test. No secret and no network beyond loopback. Nothing this script reports means
// anything until every outcome, the red ones included, has been seen to happen.
// ---------------------------------------------------------------------------

function expect(condition, what) {
  if (!condition) {
    console.error(`vault-row-count-watch: SELF-TEST FAILED: ${what}`)
    process.exit(EXIT.SELFTEST_FAILED)
  }
}

// A snapshot whose largest owner holds n rows and in which every row is attributed to an owner.
const owner = (n, rest = {}) => ({
  user_vault_rows: 0,
  customer_vault_rows: 0,
  tx_total: n + 100,
  tx_attributed: n + 100,
  tx_max_owner: n,
  conn_max_owner: 7,
  ...rest,
})

function unitChecks() {
  // Both sides of every line.
  const bands = [
    [1, 'OK'],
    [399, 'OK'],
    [400, 'LOOK-AGAIN'],
    [1999, 'LOOK-AGAIN'],
    [2000, 'WARN'],
    [4999, 'WARN'],
    [5000, 'STOP'],
    [999999, 'STOP'],
  ]
  for (const [rows, tier] of bands) {
    expect(classify(owner(rows), null).tier === tier, `${rows} rows was not ${tier}`)
  }
  expect(classify(owner(10, { conn_max_owner: 2500 }), null).tier === 'WARN', 'a large connection count did not raise the tier')

  const simulated = classify(owner(10), 6789)
  expect(simulated.tier === 'STOP' && simulated.simulated === true, 'a simulated number did not decide the tier')
  expect(classify(owner(10), null).simulated === false, 'a real run was labelled simulated')

  expect(classify(owner(10), null).vaultOwners === false, 'no vault rows was reported as present')
  expect(classify(owner(10, { user_vault_rows: 1 }), null).vaultOwners === true, 'a user vault row was not reported')
  expect(classify(owner(10, { customer_vault_rows: 1 }), null).vaultOwners === true, 'a customer vault row was not reported')

  // Anything that cannot be trusted is UNKNOWN, on a real run and on a simulated one.
  const untrusted = [
    ['an empty transactions table', owner(10, { tx_total: 0, tx_attributed: 0, tx_max_owner: 0 })],
    ['a join that dropped rows', owner(10, { tx_attributed: 50 })],
    ['a join that matched nothing', owner(10, { tx_attributed: 0, tx_max_owner: 0 })],
    ['a largest owner above the table total', owner(10, { tx_max_owner: 999999 })],
  ]
  for (const [what, snapshot] of untrusted) {
    expect(classify(snapshot, null).tier === 'UNKNOWN', `${what} was not UNKNOWN`)
    expect(classify(snapshot, 6789).tier === 'UNKNOWN', `${what} was not UNKNOWN on a simulated run`)
  }

  // Counts arrive as numbers or as strings of digits; nothing else is a count.
  const good = {
    user_vault_rows: 0,
    customer_vault_rows: '0',
    tx_total: 575,
    tx_attributed: '575',
    tx_max_owner: 402,
    conn_max_owner: 7,
  }
  const parsed = parseSnapshot([good])
  expect(
    parsed.value && parsed.value.tx_attributed === 575 && parsed.value.customer_vault_rows === 0,
    'a count sent as a string of digits was not accepted',
  )
  const unreadable = [
    ['an object instead of rows', { message: 'x' }],
    ['no rows', []],
    ['two rows', [good, good]],
    ['a missing field', [{ ...good, tx_total: undefined }]],
    ['a negative count', [{ ...good, tx_total: -1 }]],
    ['a fractional count', [{ ...good, tx_total: 1.5 }]],
    ['a non-numeric string', [{ ...good, tx_total: '12abc' }]],
    ['a null count', [{ ...good, tx_total: null }]],
    ['a row that is not an object', [null]],
  ]
  for (const [what, body] of unreadable) {
    expect(typeof parseSnapshot(body).error === 'string', `${what} was not refused`)
  }
  for (const value of [-1, 1.5, '-1', '1e3', '', 'abc', null, undefined, true, 2 ** 60, '9'.repeat(16)]) {
    expect(toCount(value) === null, `${String(value)} was accepted as a count`)
  }
  expect(toCount('23') === 23 && toCount(23) === 23 && toCount('0') === 0, 'a plain count was refused')

  // The query is one read-only statement.
  const sql = QUERY.toLowerCase()
  expect(/^\s*with\b/.test(sql) && !sql.includes(';'), 'the query is not a single statement that starts with WITH')
  expect(
    !/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call)\b/.test(sql),
    'the query contains a write keyword',
  )

  // A tier report carries a tier name and no digit, for every tier.
  const samples = { OK: 5, 'LOOK-AGAIN': 500, WARN: 2500, STOP: 5500 }
  for (const [tier, rows] of Object.entries(samples)) {
    const result = classify(owner(rows), null)
    const text = render(result)
    expect(result.tier === tier, `${rows} rows was not ${tier}`)
    expect(text.includes(tier) && !/[0-9]/.test(text), `the ${tier} report was empty or carried a digit`)
  }
  const flagged = render(classify(owner(5, { user_vault_rows: 1 }), null))
  expect(flagged.includes('PRESENT') && !/[0-9]/.test(flagged), 'a vault owner was not reported, or the report carried a digit')
}

const SELF = fileURLToPath(import.meta.url)
const TEST_REF = 'abcdefghijklmnopqrst'
const TEST_TOKEN = 'selftest-token-not-a-secret'

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve))
}

// A stand-in for the Management API on the loopback interface. It answers with the scripted
// replies in order (the last one repeats) and records whether each request had the shape the
// real API expects: method, path, bearer token and the fixed query.
function startStub(replies) {
  const seen = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      let sent
      try {
        sent = JSON.parse(raw).query
      } catch {
        sent = undefined
      }
      const shaped =
        req.method === 'POST' &&
        req.url === `/v1/projects/${TEST_REF}/database/query` &&
        req.headers.authorization === `Bearer ${TEST_TOKEN}` &&
        sent === QUERY
      seen.push(shaped)
      const [status, body] = shaped
        ? replies[Math.min(seen.length - 1, replies.length - 1)]
        : [400, { message: 'wrong request shape' }]
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, seen, root: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

// Runs the real command line, as the workflow runs it, with a clean environment.
function runRead(root, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SELF, '--read'], {
      env: {
        PATH: process.env.PATH || '',
        SUPABASE_API_URL: root,
        SUPABASE_ACCESS_TOKEN: TEST_TOKEN,
        SUPABASE_REF: TEST_REF,
        RETRY_DELAY_MS: '1',
        ...env,
      },
    })
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      out += chunk
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: null, out: String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
}

async function endToEnd() {
  const row = (rest) => [
    {
      user_vault_rows: 0,
      customer_vault_rows: 0,
      tx_total: 9000,
      tx_attributed: 9000,
      tx_max_owner: 5,
      conn_max_owner: 7,
      ...rest,
    },
  ]
  const ECHO = 'body-that-must-not-be-echoed'
  // The counts used for "hasNot" have four digits so that no timestamp can contain them.
  const cases = [
    { what: 'a real STOP', replies: [[201, row({ tx_max_owner: 5678 })]], code: 21, has: 'STOP', hasNot: '5678' },
    { what: 'a real WARN', replies: [[201, row({ tx_max_owner: 2345 })]], code: 20, has: 'WARN', hasNot: '2345' },
    { what: 'LOOK-AGAIN stays green', replies: [[201, row({ tx_max_owner: 1234 })]], code: 0, has: 'LOOK-AGAIN', hasNot: '1234' },
    { what: 'OK stays green', replies: [[200, row({})]], code: 0, has: 'WATCH: OK' },
    { what: 'a vault owner is flagged and stays green', replies: [[200, row({ user_vault_rows: 1 })]], code: 0, has: 'PRESENT' },
    { what: 'a refused token', replies: [[401, { message: ECHO }]], code: 3, has: 'refused', hasNot: ECHO },
    { what: 'an error body is never echoed', replies: [[200, { message: ECHO }]], code: 3, has: 'UNKNOWN', hasNot: ECHO },
    { what: 'an empty answer', replies: [[200, []]], code: 3, has: 'UNKNOWN' },
    {
      what: 'an empty table',
      replies: [[200, row({ tx_total: 0, tx_attributed: 0, tx_max_owner: 0 })]],
      code: 3,
      has: 'UNKNOWN',
    },
    { what: 'a join that dropped rows', replies: [[200, row({ tx_attributed: 8000 })]], code: 3, has: 'UNKNOWN' },
    {
      what: 'a server error that clears',
      replies: [[500, {}], [201, row({ tx_max_owner: 5678 })]],
      code: 21,
      has: 'STOP',
    },
    { what: 'a server error that does not clear', replies: [[500, {}]], code: 3, has: 'UNKNOWN' },
    {
      what: 'a simulated STOP on a small real count',
      replies: [[200, row({})]],
      env: { SIMULATE_MAX_ROWS: '6789' },
      code: 21,
      has: 'SIMULATED',
      hasNot: '6789',
    },
    {
      what: 'a test number that is not a count',
      env: { SIMULATE_MAX_ROWS: 'lots' },
      code: 3,
      has: 'UNKNOWN',
      reaches: false,
    },
    { what: 'no token', env: { SUPABASE_ACCESS_TOKEN: '' }, code: 3, has: 'UNKNOWN', reaches: false },
    {
      what: 'a host the token must not go to',
      env: { SUPABASE_API_URL: 'https://example.com' },
      code: 3,
      has: 'UNKNOWN',
      reaches: false,
    },
  ]

  for (const c of cases) {
    const stub = await startStub(c.replies || [[201, row({})]])
    const ran = await runRead(stub.root, c.env || {})
    await closeServer(stub.server)
    const shown = `${c.what}: exit ${ran.code}\n${ran.out}`
    const reached = c.reaches === false ? stub.seen.length === 0 : stub.seen.length > 0 && stub.seen.every(Boolean)
    expect(reached, `${c.what}: the request was malformed, or was sent when it must not be\n${shown}`)
    expect(ran.code === c.code, `${c.what}: expected exit ${c.code}\n${shown}`)
    expect(ran.out.includes(c.has), `${c.what}: the output did not say ${c.has}\n${shown}`)
    expect(!c.hasNot || !ran.out.includes(c.hasNot), `${c.what}: the output carried ${c.hasNot}\n${shown}`)
    expect(!ran.out.includes(TEST_TOKEN), `${c.what}: the token reached the output`)
  }

  // A server that is not there at all.
  const gone = await startStub([[200, []]])
  await closeServer(gone.server)
  const unreachable = await runRead(gone.root, {})
  expect(
    unreachable.code === 3 && unreachable.out.includes('did not complete') && unreachable.out.includes('UNKNOWN'),
    `an unreachable API was not reported as UNKNOWN\n${unreachable.out}`,
  )
}

async function selfTest() {
  unitChecks()
  await endToEnd()
  console.log(
    'self-test passed: every tier boundary on both sides; STOP and WARN exit non-zero and say nothing numeric; LOOK-AGAIN and OK stay green; an empty table, a join that dropped rows, an unreadable or error answer, a refused token, a server that keeps failing, an unreachable API, a missing token and a bad test number are all UNKNOWN and exit non-zero; no response body and no token ever reaches the output; the query is a single read-only statement',
  )
}

async function main() {
  const mode = process.argv[2]
  if (mode === '--selftest') {
    await selfTest()
    return
  }
  if (mode === '--read') {
    await read()
    return
  }
  console.error('vault-row-count-watch: usage: --selftest | --read')
  process.exit(EXIT.UNKNOWN)
}

main().catch((err) => {
  console.error(`vault-row-count-watch: ${err && err.message ? err.message : String(err)}`)
  process.exit(EXIT.UNKNOWN)
})
