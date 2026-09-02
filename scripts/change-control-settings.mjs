#!/usr/bin/env node
// Reads and compares the settings that gate production database changes on
// this repository: every environment's protection rules, its reviewer list,
// prevent_self_review and can_admins_bypass, plus the contents of
// MIGRATION_APPLY_ALLOWED_ACTORS_PROD and MIGRATION_APPLY_ALLOWED_ACTORS_DEV.
//
// WHY THIS EXISTS. Those settings changed on 2026-08-24 and were not noticed
// until 2026-09-02. A P1 risk ticket was closed in between on the pre-change
// values, and the verification pass confirmed the citation rather than the
// system. The change was permissive: an identity was ADDED to the production
// actor allowlist. Nothing was harmed. Nothing would have said so if it had
// been.
//
// EXIT CODES. Each failure is its own code and its own message, because a
// check that cannot look and prints OK anyway is worse than no check:
//   0  read, or compared with no drift
//   1  DRIFT: a recorded value changed. Old and new are both printed.
//   3  could not read: the API refused us (401 or 403)
//   4  could not read: the endpoint answered 404
//   5  could not read: the answer is not usable. Non-JSON, wrong shape, an
//      EMPTY environment list, or a required variable that is unset or empty.
//      An empty list is not "no protection": a repository with no
//      environments and a token that cannot see them look identical here.
//   6  no baseline is committed yet. Not a pass and not a drift.
//   7  the self-test failed, so nothing else this script says can be trusted.
//
// It never prints a token, and it reads no secret values: the two variables
// it records are allowlists of account names, which are already public in
// every workflow run log that uses them.

import fs from 'node:fs'

const API_ROOT = process.env.GITHUB_API_URL || 'https://api.github.com'

class ShapeError extends Error {}

function die(code, message) {
  console.error(`change-control-settings: ${message}`)
  process.exit(code)
}

// ---------------------------------------------------------------------------
// Classification and normalisation. Pure functions, so the self-test can
// exercise the real code rather than a stand-in written to agree with it.
// ---------------------------------------------------------------------------

export function classifyHttp(status) {
  if (status >= 200 && status < 300) return { ok: true, code: 0, kind: 'ok' }
  if (status === 401 || status === 403) {
    return { ok: false, code: 3, kind: 'refused', why: `the API refused this token (HTTP ${status}). This is NOT a report that the settings are unchanged.` }
  }
  if (status === 404) {
    return { ok: false, code: 4, kind: 'not-found', why: `the endpoint answered 404. Either the repository name is wrong or this token cannot see it. Not a report that there are no environments.` }
  }
  return { ok: false, code: 5, kind: 'unusable', why: `HTTP ${status}, which this check cannot interpret as either a value or an absence.` }
}

export function normalizeReviewer(entry) {
  const type = entry && entry.type ? entry.type : 'unknown'
  const who = entry && entry.reviewer ? (entry.reviewer.login || entry.reviewer.slug || entry.reviewer.name) : null
  return `${type}:${who || 'unknown'}`
}

export function normalizeRule(rule) {
  const out = { type: rule && rule.type ? rule.type : 'unknown' }
  if (out.type === 'wait_timer') {
    out.wait_timer = typeof rule.wait_timer === 'number' ? rule.wait_timer : null
  }
  if (out.type === 'required_reviewers') {
    // Absent means false on the API, and false is the permissive value, so it
    // must be recorded explicitly rather than left undefined and diffed away.
    out.prevent_self_review = rule.prevent_self_review === true
    const reviewers = Array.isArray(rule.reviewers) ? rule.reviewers : []
    out.reviewers = reviewers.map(normalizeReviewer).sort()
  }
  return out
}

export function normalizeEnvironments(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ShapeError('the environments response was not a JSON object')
  }
  const list = payload.environments
  if (!Array.isArray(list)) {
    throw new ShapeError('the environments response carried no environments array')
  }
  if (list.length === 0) {
    throw new ShapeError('the environments list is EMPTY. That is not a report of "no protection rules": a repository with no environments and a token that cannot see them are indistinguishable here, so this is refused rather than recorded')
  }
  return list
    .map((env) => {
      const rules = Array.isArray(env.protection_rules) ? env.protection_rules : []
      const policy = env.deployment_branch_policy
      return {
        name: env.name,
        can_admins_bypass: env.can_admins_bypass === true,
        protection_rules: rules.map(normalizeRule).sort((a, b) => a.type.localeCompare(b.type)),
        deployment_branch_policy: policy
          ? {
              protected_branches: policy.protected_branches === true,
              custom_branch_policies: policy.custom_branch_policies === true,
            }
          : null,
      }
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
}

export function normalizeActorList(name, raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new ShapeError(`${name} is unset or empty. An unset variable and a variable deliberately set to an empty string are indistinguishable from here, and one of those two would be a change to who may apply migrations, so this is refused rather than recorded as []`)
  }
  const actors = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .sort()
  if (actors.length === 0) {
    throw new ShapeError(`${name} contains no account names once separators are removed`)
  }
  return actors
}

// ---------------------------------------------------------------------------
// The diff. Reports a PATH, an OLD value and a NEW value for every leaf that
// moved, because "the settings changed" is not actionable and "an identity was
// added to the production allowlist" is.
// ---------------------------------------------------------------------------

export function diffSettings(expected, live, path = '') {
  const out = []
  const same = JSON.stringify(expected) === JSON.stringify(live)
  if (same) return out

  const bothObjects =
    expected && live && typeof expected === 'object' && typeof live === 'object' &&
    Array.isArray(expected) === Array.isArray(live)

  if (!bothObjects) {
    out.push({ path: path || '(root)', old: expected, now: live })
    return out
  }

  const keys = Array.from(new Set([...Object.keys(expected), ...Object.keys(live)]))
  for (const key of keys) {
    const child = path ? `${path}.${key}` : key
    if (!(key in expected)) {
      out.push({ path: child, old: undefined, now: live[key] })
      continue
    }
    if (!(key in live)) {
      out.push({ path: child, old: expected[key], now: undefined })
      continue
    }
    out.push(...diffSettings(expected[key], live[key], child))
  }
  return out
}

export function renderDiff(rows) {
  return rows
    .map((row) => {
      const was = row.old === undefined ? '(absent)' : JSON.stringify(row.old)
      const now = row.now === undefined ? '(absent)' : JSON.stringify(row.now)
      return `  ${row.path}\n      was: ${was}\n      now: ${now}`
    })
    .join('\n')
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function readLive() {
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) die(5, 'GITHUB_REPOSITORY is not set, so there is no repository to read')

  // Validate the recorded variables BEFORE spending a network call. An unset
  // or empty allowlist is a refusal whatever the API answers, and proving that
  // must not depend on the environments endpoint being reachable or readable.
  // A failure mode that can only be demonstrated when an unrelated call
  // succeeds is not a demonstrated failure mode.
  let variables
  try {
    variables = {
      MIGRATION_APPLY_ALLOWED_ACTORS_PROD: normalizeActorList(
        'MIGRATION_APPLY_ALLOWED_ACTORS_PROD',
        process.env.VAR_MIGRATION_APPLY_ALLOWED_ACTORS_PROD,
      ),
      MIGRATION_APPLY_ALLOWED_ACTORS_DEV: normalizeActorList(
        'MIGRATION_APPLY_ALLOWED_ACTORS_DEV',
        process.env.VAR_MIGRATION_APPLY_ALLOWED_ACTORS_DEV,
      ),
    }
  } catch (err) {
    if (err instanceof ShapeError) die(5, err.message)
    throw err
  }

  const token = process.env.GITHUB_TOKEN
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  if (token) headers.Authorization = `Bearer ${token}`

  let response
  try {
    response = await fetch(`${API_ROOT}/repos/${repo}/environments`, { headers })
  } catch (err) {
    die(5, `the environments request did not complete: ${err && err.message ? err.message : String(err)}`)
  }

  const verdict = classifyHttp(response.status)
  if (!verdict.ok) die(verdict.code, `could not read environments for ${repo}: ${verdict.why}`)

  const body = await response.text()
  let payload
  try {
    payload = JSON.parse(body)
  } catch {
    die(5, `the environments response was not JSON (${body.length} bytes). The token is never echoed, so the body is not printed here.`)
  }

  let environments
  try {
    environments = normalizeEnvironments(payload)
  } catch (err) {
    if (err instanceof ShapeError) die(5, err.message)
    throw err
  }

  return { repo, read_at: new Date().toISOString(), environments, variables }
}

// ---------------------------------------------------------------------------
// Self-test. No network. Proves the comparison goes red on each class of
// change that matters, green on an identical reading, and that every "could
// not look" is classified as its own failure rather than as a pass.
// ---------------------------------------------------------------------------

function expect(condition, what) {
  if (!condition) die(7, `SELF-TEST FAILED: ${what}`)
}

function fixture() {
  return {
    repo: 'owner/name',
    environments: [
      {
        name: 'supabase-prod',
        can_admins_bypass: false,
        protection_rules: [
          { type: 'required_reviewers', prevent_self_review: true, reviewers: ['User:alice'] },
          { type: 'wait_timer', wait_timer: 0 },
        ],
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      },
    ],
    variables: {
      MIGRATION_APPLY_ALLOWED_ACTORS_PROD: ['alice'],
      MIGRATION_APPLY_ALLOWED_ACTORS_DEV: ['alice', 'bob'],
    },
  }
}

function selfTest() {
  // GREEN: an identical reading compares clean.
  expect(diffSettings(fixture(), fixture()).length === 0, 'an identical reading was reported as a change')

  // RED: an identity ADDED to the production allowlist. This is the exact
  // change that happened on 2026-08-24 and went unseen for seven days.
  const added = fixture()
  added.variables.MIGRATION_APPLY_ALLOWED_ACTORS_PROD = ['alice', 'mallory']
  const addedRows = diffSettings(fixture(), added)
  expect(addedRows.length > 0, 'an identity added to the production allowlist was reported as clean')
  expect(
    JSON.stringify(addedRows).includes('mallory'),
    'the allowlist diff did not name the identity that was added',
  )

  // RED: prevent_self_review turned off. Permissive, and invisible in a count.
  const selfReview = fixture()
  selfReview.environments[0].protection_rules[0].prevent_self_review = false
  expect(diffSettings(fixture(), selfReview).length > 0, 'prevent_self_review turning off was reported as clean')

  // RED: admins allowed to bypass.
  const bypass = fixture()
  bypass.environments[0].can_admins_bypass = true
  expect(diffSettings(fixture(), bypass).length > 0, 'can_admins_bypass turning on was reported as clean')

  // RED: a reviewer removed. The list shortens without any flag changing.
  const noReviewer = fixture()
  noReviewer.environments[0].protection_rules[0].reviewers = []
  expect(diffSettings(fixture(), noReviewer).length > 0, 'a removed reviewer was reported as clean')

  // RED: an environment disappearing entirely.
  const noEnv = fixture()
  noEnv.environments = []
  expect(diffSettings(fixture(), noEnv).length > 0, 'an environment disappearing was reported as clean')

  // The diff must name old and new, not merely that something moved.
  const rendered = renderDiff(addedRows)
  expect(rendered.includes('was:') && rendered.includes('now:'), 'the rendered diff does not carry both the old and the new value')

  // Every "could not look" is its own non-zero outcome, and none of them is 0.
  expect(classifyHttp(200).ok === true, '200 was not treated as readable')
  expect(classifyHttp(401).code === 3, '401 was not classified as refused')
  expect(classifyHttp(403).code === 3, '403 was not classified as refused')
  expect(classifyHttp(404).code === 4, '404 was not classified as not-found')
  expect(classifyHttp(500).code === 5, '500 was not classified as unusable')
  expect(classifyHttp(302).ok === false, 'a redirect was treated as a successful read')

  // Shape failures are refusals, never an empty recording.
  let threw = false
  try { normalizeEnvironments({ environments: [] }) } catch (e) { threw = e instanceof ShapeError }
  expect(threw, 'an EMPTY environment list was accepted as a reading instead of refused')

  threw = false
  try { normalizeEnvironments({ ok: true }) } catch (e) { threw = e instanceof ShapeError }
  expect(threw, 'a response with no environments array was accepted')

  threw = false
  try { normalizeActorList('X', '') } catch (e) { threw = e instanceof ShapeError }
  expect(threw, 'an empty actor allowlist was recorded as [] instead of refused')

  threw = false
  try { normalizeActorList('X', undefined) } catch (e) { threw = e instanceof ShapeError }
  expect(threw, 'an unset actor allowlist was recorded instead of refused')

  // Normalisation must not invent stability: order and spacing in the variable
  // are noise, everything else is signal.
  expect(
    JSON.stringify(normalizeActorList('X', 'b , a')) === JSON.stringify(['a', 'b']),
    'the actor list was not normalised to a sorted, trimmed list',
  )
  expect(
    normalizeRule({ type: 'required_reviewers', reviewers: [] }).prevent_self_review === false,
    'an absent prevent_self_review was not recorded as the permissive value it is',
  )

  console.log('self-test passed: the comparison goes red on an added allowlist identity, a disabled prevent_self_review, an enabled admin bypass, a removed reviewer and a removed environment, green on an identical reading, and every unreadable answer (401, 403, 404, 5xx, non-JSON, empty list, empty variable) is its own non-zero refusal rather than a pass')
}

// ---------------------------------------------------------------------------

async function main() {
  const mode = process.argv[2]

  if (mode === '--self-test') {
    selfTest()
    return
  }

  if (mode === '--read') {
    const reading = await readLive()
    const target = process.argv[3]
    const text = JSON.stringify(reading, null, 2) + '\n'
    if (!target || target === '--stdout') process.stdout.write(text)
    else {
      fs.writeFileSync(target, text)
      console.error(`wrote the reading of ${reading.repo} to ${target}`)
    }
    return
  }

  if (mode === '--compare') {
    const expectedPath = process.argv[3]
    const livePath = process.argv[4]
    if (!expectedPath || !livePath) die(5, 'usage: --compare <baseline.json> <live.json>')
    if (!fs.existsSync(expectedPath)) {
      die(6, `no baseline is committed at ${expectedPath}. This is NOT a pass and NOT a drift: there is nothing to compare against yet. Commit the reading printed by --read, in a reviewed pull request, so the first recorded values are ones a person looked at.`)
    }
    const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'))
    const live = JSON.parse(fs.readFileSync(livePath, 'utf8'))

    // read_at is when we looked, not what we found. Comparing it would make
    // every run a drift and teach everyone to ignore this check.
    delete expected.read_at
    const readAt = live.read_at
    delete live.read_at

    const rows = diffSettings(expected, live)
    if (rows.length > 0) {
      console.error(`change-control-settings: DRIFT. ${rows.length} value(s) differ from ${expectedPath}, read at ${readAt}:`)
      console.error(renderDiff(rows))
      process.exit(1)
    }
    console.log(`change-control-settings: no drift. ${expectedPath} matches what the API reports, read at ${readAt}.`)
    return
  }

  die(5, 'usage: --self-test | --read [path] | --compare <baseline.json> <live.json>')
}

main().catch((err) => {
  die(5, err && err.stack ? err.stack : String(err))
})
