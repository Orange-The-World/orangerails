#!/usr/bin/env node
// Account deletion must clear the vault meta rows it owns (DEV-0323).
//
// Runs scripts/sql/account-deletion-cascade.sql against a Supabase project
// through the Management API SQL endpoint, which authenticates with
// SUPABASE_ACCESS_TOKEN and needs no database password. That is the same
// endpoint the migration apply step uses, so this check needs no new
// credential.
//
// WHY THE HTTP STATUS IS NOT THE VERDICT. The SQL always ends by raising an
// exception, because the raise is what rolls its fixture back. So the API
// answers 400 for a pass AND for a fail, and a 2xx means the SQL returned
// without asserting anything. The verdict is the sentinel in the message:
//
//   DEV0323_PASS   -> exit 0
//   DEV0323_FAIL   -> exit 1, the message names the leg that broke
//   neither        -> exit 1 as UNKNOWN. Not a pass. Go and look.
//
// UNKNOWN is deliberately loud and deliberately separate. "I could not find
// out" and "I found nothing wrong" are different facts and must never share a
// message or an exit code.
//
// Usage:
//   SUPABASE_ACCESS_TOKEN=... SUPABASE_REF=... node scripts/check-account-deletion-cascade.mjs
//   node scripts/check-account-deletion-cascade.mjs --selftest

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_PATH = join(HERE, 'sql', 'account-deletion-cascade.sql');

// This check writes a fixture, even though it rolls it back. It is allowed on
// the dev project only. Refusing the prod ref by name is cheap and it removes
// the one mistake that would matter: a copied workflow line, or a dispatch
// from the wrong branch, pointing a fixture at real customer data.
const PROD_REF = 'lcdicqalreskibdfxkzb';

const SENTINEL = 'DEV0323_';

// Everything the fixture writes carries this prefix, so a residue query can
// find it by name rather than by guessing which rows were ours.
const RESIDUE_SQL = `
SELECT count(*)::int AS residue FROM (
  SELECT 1 FROM auth.users                 WHERE email      LIKE 'dev0323-%'
  UNION ALL
  SELECT 1 FROM public.customers           WHERE email      LIKE 'dev0323-%'
  UNION ALL
  SELECT 1 FROM public.user_vault_meta     WHERE vault_salt LIKE 'dev0323-%'
  UNION ALL
  SELECT 1 FROM public.customer_vault_meta WHERE vault_salt LIKE 'dev0323-%'
) s;`;

/**
 * Pull the verdict out of an API response.
 *
 * Returns { verdict: 'PASS' | 'FAIL' | 'UNKNOWN', detail } where detail is
 * either the sentinel text or a short reason. detail NEVER contains the raw
 * response body: on an auth failure that body is the only place a token shaped
 * string could surface in a public build log.
 */
export function classify(status, bodyText) {
  const text = typeof bodyText === 'string' ? bodyText : '';
  const at = text.indexOf(SENTINEL);

  if (at === -1) {
    if (status >= 200 && status < 300) {
      return {
        verdict: 'UNKNOWN',
        detail:
          `the SQL returned HTTP ${status} without raising. It is written to always raise, ` +
          'so it has been edited into something that no longer asserts, or it never ran.',
      };
    }
    return {
      verdict: 'UNKNOWN',
      detail:
        `HTTP ${status} and no ${SENTINEL} verdict in the response. Most often an expired or ` +
        'rotated SUPABASE_ACCESS_TOKEN, a paused project, or a syntax error in the SQL. ' +
        'The body is not printed here on purpose.',
    };
  }

  // Trim to one line: the API wraps the message with a CONTEXT block.
  const line = text.slice(at).split('\\n')[0].split('\n')[0].trim();

  if (line.startsWith('DEV0323_PASS')) return { verdict: 'PASS', detail: line };
  if (line.startsWith('DEV0323_FAIL')) return { verdict: 'FAIL', detail: line };
  return {
    verdict: 'UNKNOWN',
    detail: `unrecognised ${SENTINEL} verdict: ${line}`,
  };
}

/** Read the residue count out of the Management API's row array. */
export function residueCount(parsed) {
  if (!Array.isArray(parsed)) {
    throw new Error('the residue query returned a success status but not a JSON array of rows');
  }
  if (parsed.length !== 1 || typeof parsed[0]?.residue !== 'number') {
    throw new Error('the residue query returned an array without a single numeric residue column');
  }
  return parsed[0].residue;
}

async function runSql(ref, token, sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  return { status: res.status, text: await res.text() };
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function selftest() {
  const cases = [
    ['a pass on the real 400 shape', 400, '{"message":"ERROR: P0001: DEV0323_PASS all three legs held\\nCONTEXT: x"}', 'PASS'],
    ['a fail names the leg', 400, '{"message":"ERROR: P0001: DEV0323_FAIL deleting the account left 1 row(s) behind\\nCONTEXT: x"}', 'FAIL'],
    ['a 2xx means the SQL stopped asserting', 200, '[]', 'UNKNOWN'],
    ['an auth failure is unknown, not a pass', 401, '{"message":"Unauthorized"}', 'UNKNOWN'],
    ['an unrecognised sentinel is unknown', 400, 'DEV0323_MAYBE something', 'UNKNOWN'],
    ['an empty body is unknown', 500, '', 'UNKNOWN'],
  ];

  let bad = 0;
  for (const [name, status, body, want] of cases) {
    const got = classify(status, body).verdict;
    if (got !== want) {
      console.error(`  FAIL ${name}: expected ${want}, got ${got}`);
      bad += 1;
    } else {
      console.log(`  ok   ${name} -> ${got}`);
    }
  }

  // The leak case gets its own assertion rather than riding on a verdict:
  // a classifier that returns the right word while pasting the body into the
  // log has still failed.
  const secretish = '{"message":"Unauthorized","hint":"sbp_0123456789abcdef"}';
  const leaked = classify(401, secretish).detail;
  if (leaked.includes('sbp_0123456789abcdef')) {
    console.error('  FAIL an unknown verdict must not echo the response body');
    bad += 1;
  } else {
    console.log('  ok   an unknown verdict does not echo the response body');
  }

  const residueCases = [
    ['zero residue parses', [{ residue: 0 }], 0],
    ['a non zero residue parses', [{ residue: 3 }], 3],
  ];
  for (const [name, parsed, want] of residueCases) {
    const got = residueCount(parsed);
    if (got !== want) {
      console.error(`  FAIL ${name}: expected ${want}, got ${got}`);
      bad += 1;
    } else {
      console.log(`  ok   ${name} -> ${got}`);
    }
  }
  for (const [name, parsed] of [
    ['an object is not a usable residue answer', { residue: 0 }],
    ['an empty array is not a usable residue answer', []],
  ]) {
    let threw = false;
    try {
      residueCount(parsed);
    } catch {
      threw = true;
    }
    if (!threw) {
      console.error(`  FAIL ${name}: expected a throw`);
      bad += 1;
    } else {
      console.log(`  ok   ${name}`);
    }
  }

  if (bad > 0) {
    console.error(`selftest: ${bad} case(s) failed`);
    process.exit(1);
  }
  console.log('selftest: all cases passed');
}

async function main() {
  if (process.argv.includes('--selftest')) {
    selftest();
    return;
  }

  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const ref = process.env.SUPABASE_REF;

  if (!token) fail('SUPABASE_ACCESS_TOKEN is not set. This check cannot reach a database.');
  if (!ref) fail('SUPABASE_REF is not set. Refusing to guess which project to write a fixture to.');
  if (ref === PROD_REF) {
    fail(
      `Refusing to run: ${PROD_REF} is the production project. This check writes a fixture, ` +
        'and rolling it back afterwards is not a reason to write it against real customer data.',
    );
  }

  const sql = readFileSync(SQL_PATH, 'utf8');
  if (!sql.includes(SENTINEL)) {
    fail(`${SQL_PATH} contains no ${SENTINEL} verdict. It cannot report anything; fix the file.`);
  }

  let last = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let res;
    try {
      res = await runSql(ref, token, sql);
    } catch (err) {
      last = { verdict: 'UNKNOWN', detail: `request failed: ${err?.name ?? 'Error'}` };
      console.log(`attempt ${attempt}/3 did not complete`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 10_000));
      continue;
    }

    last = classify(res.status, res.text);
    if (last.verdict !== 'UNKNOWN') break;

    console.log(`attempt ${attempt}/3 produced no verdict (HTTP ${res.status})`);
    if (attempt < 3) await new Promise((r) => setTimeout(r, 10_000));
  }

  if (last.verdict === 'FAIL') {
    fail(`Account deletion no longer clears the vault meta rows it owns on ${ref}. ${last.detail}`);
  }
  if (last.verdict !== 'PASS') {
    fail(
      `Could not determine whether account deletion clears the vault meta rows on ${ref}. ` +
        `This is NOT a report that the cascade is fine. ${last.detail}`,
    );
  }

  console.log(last.detail);

  // The assertion rolled its own transaction back. Prove that rather than
  // assume it: a fixture left behind on a shared project is a real cost, and
  // a rollback that quietly stopped happening would be invisible.
  const residue = await runSql(ref, token, RESIDUE_SQL);
  if (residue.status < 200 || residue.status >= 300) {
    fail(
      `The assertion passed but the residue check could not run (HTTP ${residue.status}), so it ` +
        'is not known whether the fixture rolled back. Check for rows marked dev0323- by hand.',
    );
  }

  let count;
  try {
    count = residueCount(JSON.parse(residue.text));
  } catch (err) {
    fail(`The assertion passed but the residue check could not be read: ${err.message}`);
  }

  if (count !== 0) {
    fail(
      `The assertion passed but left ${count} fixture row(s) behind on ${ref}. The transaction did ` +
        'not roll back. Remove the rows marked dev0323- before trusting this check again.',
    );
  }

  console.log(`Fixture rolled back cleanly: 0 residue rows on ${ref}.`);
}

main().catch((err) => {
  console.error(`::error::check-account-deletion-cascade crashed: ${err?.message ?? err}`);
  process.exit(1);
});
