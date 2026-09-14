#!/usr/bin/env node
// Generates the RLS policy baseline TSV from the live pg_policies view,
// via the Supabase Management API (CI has no direct DB password).
//
// Row shape, tab separated, one policy per line:
//   schemaname  tablename  policyname  cmd  roles  qual_md5  with_check_md5
//
// We hash qual/with_check instead of comparing raw text because
// pg_get_expr can reformat semantically identical SQL differently
// between reads (parenthesization, whitespace), which would show up
// as constant diff noise on an otherwise-unchanged policy.
//
// Exit codes: 0 = wrote/printed the baseline. 2 = could not produce a
// trustworthy result (network, auth, or shape failure). Never exit 0
// on a failure path: a silent empty baseline would read as "no
// policies exist" and mask every future removal.

import fs from 'node:fs'

const QUERY = `
  select
    schemaname,
    tablename,
    policyname,
    cmd,
    array_to_string(roles, ',') as roles,
    md5(coalesce(qual, '')) as qual_md5,
    md5(coalesce(with_check, '')) as with_check_md5
  from pg_policies
  where schemaname = 'public'
  order by schemaname, tablename, policyname;
`

function fail(message) {
  console.error(`generate-rls-policy-baseline: ${message}`)
  process.exit(2)
}

async function fetchPolicies() {
  const token = process.env.SUPABASE_ACCESS_TOKEN
  const ref = process.env.SUPABASE_PROJECT_REF
  if (!token) fail('SUPABASE_ACCESS_TOKEN is not set')
  if (!ref) fail('SUPABASE_PROJECT_REF is not set')

  const url = `https://api.supabase.com/v1/projects/${ref}/database/query`
  const attempts = 3
  let lastStatus = null
  let lastBodySnippet = ''

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: QUERY }),
      })
    } catch (err) {
      lastStatus = 'network-error'
      lastBodySnippet = String(err && err.message ? err.message : err)
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, 10_000 * attempt))
        continue
      }
      fail(`request failed after ${attempts} attempts: ${lastBodySnippet}`)
    }

    const bodyText = await response.text()
    if (!response.ok) {
      lastStatus = response.status
      lastBodySnippet = bodyText.slice(0, 300)
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, 10_000 * attempt))
        continue
      }
      fail(
        `Management API returned ${lastStatus} after ${attempts} attempts: ${lastBodySnippet}`,
      )
    }

    let parsed
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      fail(`response was not valid JSON: ${bodyText.slice(0, 300)}`)
    }

    if (!Array.isArray(parsed)) {
      fail(
        `expected a JSON array of policy rows, got ${typeof parsed}: ${bodyText.slice(0, 300)}`,
      )
    }

    return parsed
  }

  // Unreachable, but keeps control flow explicit rather than falling
  // through to an implicit undefined return.
  fail(`exhausted ${attempts} attempts, last status ${lastStatus}`)
}

function toTsv(rows) {
  const lines = rows.map((row) =>
    [
      row.schemaname,
      row.tablename,
      row.policyname,
      row.cmd,
      `{${row.roles}}`,
      row.qual_md5,
      row.with_check_md5,
    ].join('\t'),
  )
  return lines.join('\n') + '\n'
}

async function main() {
  const rows = await fetchPolicies()
  if (rows.length === 0) {
    fail(
      'query returned zero policy rows; refusing to write an empty baseline (this would silently accept every future policy removal)',
    )
  }

  const tsv = toTsv(rows)
  const target = process.argv[2]

  if (!target || target === '--stdout') {
    process.stdout.write(tsv)
  } else {
    fs.writeFileSync(target, tsv)
    console.error(`wrote ${rows.length} polic${rows.length === 1 ? 'y' : 'ies'} to ${target}`)
  }
}

main().catch((err) => {
  fail(err && err.stack ? err.stack : String(err))
})
