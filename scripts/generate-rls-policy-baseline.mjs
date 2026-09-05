#!/usr/bin/env node
// Generates the RLS baseline TSVs from the live pg_policies and pg_class
// views, via the Supabase Management API (CI has no direct DB password).
//
// Writes TWO files:
//
//   <target>              the POLICY baseline (unchanged name/shape, one
//                          column added). One row per policy in schemaname
//                          'public':
//     schemaname  tablename  policyname  cmd  permissive  roles  qual_md5  with_check_md5
//
//   <target-tables>        the TABLE baseline (new, OR-T1601). One row per
//                          base table in schema 'public', whether or not it
//                          carries any policy:
//     schemaname  tablename  relrowsecurity  relforcerowsecurity  policy_count
//
// <target-tables> is derived from <target> by inserting '-tables' before the
// extension, e.g. supabase/rls-policy-baseline.dev.tsv ->
// supabase/rls-policy-baseline.dev-tables.tsv. --stdout prints the policy
// TSV followed by a blank line then the table TSV.
//
// WHY TWO BASELINES AND NOT ONE WIDER ROW. A policy row and a table row
// have different cardinality: a table with zero policies (RLS enforced by
// the enable bit alone, or RLS switched off entirely with nothing to name)
// would have to be represented as either a phantom policy row or a special
// case in the diff. Two files, two independent diffs, no special case.
//
// WHY THIS EXISTS (OR-T1601). pg_policies has no relrowsecurity or
// relforcerowsecurity column and lists a table's policies whether or not
// row level security is switched on for that table. `alter table
// public.some_table disable row level security` changes not one byte of
// the policy baseline: the job would print "matches" and the table would be
// readable by anyone holding the grant. This is the fix: pin the enable
// bits and the policy count directly off pg_class, independent of whether
// any policy exists to name.
//
// We hash qual/with_check instead of comparing raw text because
// pg_get_expr can reformat semantically identical SQL differently between
// reads (parenthesization, whitespace), which would show up as constant
// diff noise on an otherwise-unchanged policy.
//
// Exit codes: 0 = wrote/printed both baselines. 2 = could not produce a
// trustworthy result (network, auth, or shape failure) for EITHER query.
// Never exit 0 on a failure path: a silent empty or partial baseline would
// read as "nothing to see" and mask every future regression.

import fs from 'node:fs'
import path from 'node:path'

const POLICY_QUERY = `
  select
    schemaname,
    tablename,
    policyname,
    cmd,
    permissive,
    array_to_string(roles, ',') as roles,
    md5(coalesce(qual, '')) as qual_md5,
    md5(coalesce(with_check, '')) as with_check_md5
  from pg_policies
  where schemaname = 'public'
  order by schemaname, tablename, policyname;
`

// relkind = 'r' is an ordinary base table. Views, materialized views,
// foreign tables and partitions of a table are a different question with a
// different answer and are deliberately excluded: RLS applies to base
// tables, and mixing relkinds into one baseline would make a real "a table
// stopped being a table" event indistinguishable from a partition being
// renamed as part of routine maintenance.
const TABLE_QUERY = `
  select
    n.nspname as schemaname,
    c.relname as tablename,
    c.relrowsecurity as relrowsecurity,
    c.relforcerowsecurity as relforcerowsecurity,
    coalesce(p.policy_count, 0) as policy_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join (
    select tablename, count(*) as policy_count
    from pg_policies
    where schemaname = 'public'
    group by tablename
  ) p on p.tablename = c.relname
  where n.nspname = 'public'
    and c.relkind = 'r'
  order by n.nspname, c.relname;
`

function fail(message) {
  console.error(`generate-rls-policy-baseline: ${message}`)
  process.exit(2)
}

async function runManagementQuery(query, label) {
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
        body: JSON.stringify({ query }),
      })
    } catch (err) {
      lastStatus = 'network-error'
      lastBodySnippet = String(err && err.message ? err.message : err)
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, 10_000 * attempt))
        continue
      }
      fail(`${label}: request failed after ${attempts} attempts: ${lastBodySnippet}`)
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
        `${label}: Management API returned ${lastStatus} after ${attempts} attempts: ${lastBodySnippet}`,
      )
    }

    let parsed
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      fail(`${label}: response was not valid JSON: ${bodyText.slice(0, 300)}`)
    }

    if (!Array.isArray(parsed)) {
      fail(
        `${label}: expected a JSON array of rows, got ${typeof parsed}: ${bodyText.slice(0, 300)}`,
      )
    }

    return parsed
  }

  // Unreachable, but keeps control flow explicit rather than falling
  // through to an implicit undefined return.
  fail(`${label}: exhausted ${attempts} attempts, last status ${lastStatus}`)
}

function policiesToTsv(rows) {
  const lines = rows.map((row) =>
    [
      row.schemaname,
      row.tablename,
      row.policyname,
      row.cmd,
      row.permissive,
      `{${row.roles}}`,
      row.qual_md5,
      row.with_check_md5,
    ].join('\t'),
  )
  return lines.join('\n') + '\n'
}

function tablesToTsv(rows) {
  const lines = rows.map((row) =>
    [
      row.schemaname,
      row.tablename,
      // Booleans come back from the Management API as JSON true/false;
      // render them literally so the TSV is stable and greppable rather
      // than depending on JS's default String(bool) staying "true"/"false".
      row.relrowsecurity === true ? 'true' : 'false',
      row.relforcerowsecurity === true ? 'true' : 'false',
      String(row.policy_count),
    ].join('\t'),
  )
  return lines.join('\n') + '\n'
}

function tablesSidecarPath(target) {
  const dir = path.dirname(target)
  const ext = path.extname(target)
  const base = path.basename(target, ext)
  return path.join(dir, `${base}-tables${ext}`)
}

async function main() {
  const policyRows = await runManagementQuery(POLICY_QUERY, 'policy query')
  if (policyRows.length === 0) {
    fail(
      'policy query returned zero rows; refusing to write an empty baseline (this would silently accept every future policy removal)',
    )
  }

  const tableRows = await runManagementQuery(TABLE_QUERY, 'table query')
  if (tableRows.length === 0) {
    fail(
      'table query returned zero rows; refusing to write an empty table baseline (this would silently accept RLS being disabled on every table, since there would be nothing to compare against)',
    )
  }

  const policyTsv = policiesToTsv(policyRows)
  const tableTsv = tablesToTsv(tableRows)
  const target = process.argv[2]

  if (!target || target === '--stdout') {
    process.stdout.write(policyTsv)
    process.stdout.write('\n')
    process.stdout.write(tableTsv)
  } else {
    fs.writeFileSync(target, policyTsv)
    const tablesPath = tablesSidecarPath(target)
    fs.writeFileSync(tablesPath, tableTsv)
    console.error(
      `wrote ${policyRows.length} polic${policyRows.length === 1 ? 'y' : 'ies'} to ${target}`,
    )
    console.error(`wrote ${tableRows.length} table row(s) to ${tablesPath}`)
  }
}

main().catch((err) => {
  fail(err && err.stack ? err.stack : String(err))
})
