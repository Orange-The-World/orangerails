#!/usr/bin/env node
/**
 * CI gate: our SQL may not leave the `anon` role able to EXECUTE a function in the `public`
 * schema unless that function is on a checked-in allowlist with a written reason.
 *
 * WHY THIS EXISTS. On this project every function created in `public` is born executable by
 * `anon`, because the schema's default privileges grant it on creation. That is a project
 * level setting, not something any migration of ours asked for, so reading our SQL never
 * revealed it. Once that default is tightened, the opposite risk begins: an RPC that
 * genuinely needs `anon` must declare it out loud, and one that does not must never quietly
 * get the grant back.
 *
 * WHAT IT CHECKS, exactly:
 *   1. Migrations are replayed in filename order and GRANT / REVOKE are folded into an END
 *      STATE. What is compared against the allowlist is what our SQL finally declares, not
 *      every statement we ever wrote, so a grant that a later migration takes away is fine.
 *   2. Anything left executable by `anon` or by `PUBLIC` must have an allowlist entry.
 *   3. An allowlist entry with no matching grant also fails, so the list cannot rot into a
 *      record of things we used to do.
 *   4. Re-widening the schema default (ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON
 *      FUNCTIONS TO anon) and a blanket GRANT ON ALL FUNCTIONS IN SCHEMA public are refused
 *      outright. Neither is allowlistable: they are the condition this gate exists to end.
 *      The opposite statement, ALTER DEFAULT PRIVILEGES ... REVOKE, is the durable fix and
 *      passes on purpose.
 *
 * WHAT IT DOES NOT CHECK, and no one should assume otherwise. Two blind spots, both real.
 *
 * First, this reads our SQL, not the live database. A grant typed by hand into a SQL console
 * never reaches a migration and this gate will not see it. Catching that needs a live read of
 * pg_proc.proacl on both projects, which needs a database credential CI does not hold, so it
 * stays a periodic check by the database steward.
 *
 * Second, and this is the one that bites on day one: the grants we are actually fighting here
 * are inherited from the schema's default privileges, not written by any migration. There is
 * no GRANT statement in the repo to fold. So this gate can report a clean source scan and an
 * empty allowlist at the same moment that functions in `public` are anon-executable on the
 * live database, with no bug in the parser. Say it plainly: THIS GATE PROVES NO MIGRATION
 * WIDENS THE SURFACE. IT DOES NOT PROVE THE SURFACE IS NARROW. Narrowing it is the default
 * privileges change plus the steward's live sweep; this gate is what stops it widening again.
 *
 * Both limits are written here rather than only in the pull request, because a control that
 * appears to cover more than it does is what stops anyone from looking at the rest.
 *
 * Rejected alternative: inferring intent from function bodies. The public-auth gate in this
 * same repo tried detection before declaration and produced six false negatives, because the
 * real logic lived in a shared helper the pattern did not know about.
 *
 * Run `node scripts/check-anon-rpc-grants.mjs --selftest` to exercise the parser itself.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = "supabase/migrations";
const ALLOWLIST = "supabase/anon-executable-rpcs.json";
const GUARDED_SCHEMA = "public";

/**
 * Split SQL into statements, discarding line comments, block comments, single-quoted string
 * literals and dollar-quoted function bodies. Bodies are dropped whole so that a semicolon or
 * the word `anon` inside PL/pgSQL cannot be read as a top level statement.
 */
function statements(sql) {
  const out = [];
  let cur = "";
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      cur += " ";
      continue;
    }
    if (two === "/*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.slice(i, i + 2) === "/*") { depth += 1; i += 2; continue; }
        if (sql.slice(i, i + 2) === "*/") { depth -= 1; i += 2; continue; }
        i += 1;
      }
      cur += " ";
      continue;
    }
    if (sql[i] === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i += 1; break; }
        i += 1;
      }
      cur += " '_' ";
      continue;
    }
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end === -1 ? sql.length : end + tag.length;
      cur += " _body_ ";
      continue;
    }
    if (sql[i] === ";") { out.push(cur); cur = ""; i += 1; continue; }
    cur += sql[i];
    i += 1;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** Everything after the last standalone occurrence of a keyword, or null. */
function tailAfter(stmt, keyword) {
  const re = new RegExp(`\\b${keyword}\\b`, "gi");
  let match;
  let end = -1;
  while ((match = re.exec(stmt)) !== null) end = match.index + match[0].length;
  return end === -1 ? null : stmt.slice(end);
}

/** True when a grantee list includes `anon` or the PUBLIC pseudo-role. */
function includesAnon(list) {
  if (!list) return false;
  return /(^|[\s,(])(anon|public)(\s|,|\)|$)/i.test(list.replace(/"/g, ""));
}

/** Normalised key for a function target: public.name or public.name(argtype,argtype). */
function functionKey(rawName, rawArgs) {
  let name = rawName.replace(/"/g, "").toLowerCase();
  if (!name.includes(".")) name = `${GUARDED_SCHEMA}.${name}`;
  if (!rawArgs) return name;
  const args = rawArgs
    .replace(/^\(|\)$/g, "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean)
    .join(",");
  return `${name}(${args})`;
}

const bareName = (key) => key.split("(")[0];

/**
 * Fold a set of migrations into the end state their SQL declares.
 * `files` is an ordered array of { name, sql }. Returns { granted, hard }.
 */
export function scan(files) {
  const granted = new Map();
  const hard = [];

  const blanketRe = /\bON\s+ALL\s+(?:FUNCTIONS|ROUTINES|PROCEDURES)\s+IN\s+SCHEMA\s+([a-z_][a-z0-9_]*)/i;
  const namedRe = /\bON\s+(?:FUNCTION|ROUTINE|PROCEDURE)\s+((?:"[^"]+"|[a-z0-9_]+)(?:\.(?:"[^"]+"|[a-z0-9_]+))?)\s*(\([^)]*\))?/i;

  for (const file of files) {
    for (const stmt of statements(file.sql)) {
      const isDefaultPrivs = /^ALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(stmt);
      const hasExecute = /\bEXECUTE\b/i.test(stmt);
      if (!hasExecute) continue;

      if (isDefaultPrivs) {
        const schema = /\bIN\s+SCHEMA\s+([a-z_][a-z0-9_]*)/i.exec(stmt);
        if (!schema || schema[1].toLowerCase() !== GUARDED_SCHEMA) continue;
        // A REVOKE of the schema default is the durable fix, so it passes. Only the widening
        // direction is refused, and REVOKE GRANT OPTION FOR is read as the revoke it is.
        if (!/^ALTER\s+DEFAULT\s+PRIVILEGES\b(?:(?!\bREVOKE\b).)*\bGRANT\b/i.test(stmt)) continue;
        if (includesAnon(tailAfter(stmt, "TO"))) {
          hard.push(
            `${file.name}: ALTER DEFAULT PRIVILEGES grants EXECUTE on future ${GUARDED_SCHEMA} ` +
            `functions to anon. Every RPC shipped after this is born public. This is not ` +
            `allowlistable. Grant anon on the one function that needs it instead.`);
        }
        continue;
      }

      const isGrant = /^GRANT\b/i.test(stmt);
      const isRevoke = /^REVOKE\b/i.test(stmt);
      if (!isGrant && !isRevoke) continue;

      const targets = includesAnon(tailAfter(stmt, isGrant ? "TO" : "FROM"));
      if (!targets) continue;

      const blanket = blanketRe.exec(stmt);
      if (blanket) {
        if (blanket[1].toLowerCase() !== GUARDED_SCHEMA) continue;
        if (isGrant) {
          hard.push(
            `${file.name}: blanket GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${GUARDED_SCHEMA} ` +
            `to anon. This hands out every RPC at once, including ones written later. Not ` +
            `allowlistable: name the single function that needs it.`);
        } else {
          granted.clear();
        }
        continue;
      }

      const named = namedRe.exec(stmt);
      if (!named) continue;
      const key = functionKey(named[1], named[2]);
      if (!key.startsWith(`${GUARDED_SCHEMA}.`)) continue; // other schemas are out of scope here

      if (isGrant) {
        granted.set(key, file.name);
      } else {
        // Revoking is the safe direction, so match broadly: an unsignatured REVOKE clears
        // every overload, and a signatured one also clears an unsignatured GRANT.
        for (const existing of [...granted.keys()]) {
          if (existing === key || bareName(existing) === bareName(key)) granted.delete(existing);
        }
      }
    }
  }

  return { granted, hard };
}

/** Compare the declared end state against the allowlist. Returns an array of failures. */
export function compare(granted, hard, allowlist) {
  const fail = [...hard];
  const listed = new Set(Object.keys(allowlist ?? {}));

  for (const [key, file] of granted) {
    if (!listed.has(key)) {
      fail.push(
        `${key}: granted EXECUTE to anon in ${file} but not declared in ${ALLOWLIST}. An RPC ` +
        `callable without a signed-in user is a public endpoint. If that is intended, add the ` +
        `key "${key}" with a one line reason. If it is not, revoke the grant.`);
    }
  }
  for (const key of listed) {
    if (!granted.has(key)) {
      fail.push(
        `${key}: declared in ${ALLOWLIST} but no migration grants it to anon. Remove the entry ` +
        `so the list stays a record of what is true today, not of what used to be.`);
    }
  }
  return fail;
}

/* ------------------------------------------------------------------ self-test ------ */

const CASES = [
  {
    name: "revoking the schema default is the fix, not a failure",
    files: [{ name: "a.sql", sql: "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;" }],
    allowlist: {},
    expect: 0,
  },
  {
    name: "revoking the schema default FOR ROLE also passes",
    files: [{ name: "a.sql", sql: "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;" }],
    allowlist: {},
    expect: 0,
  },
  {
    name: "REVOKE GRANT OPTION FOR is read as a revoke, not a grant",
    files: [{ name: "a.sql", sql: "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE GRANT OPTION FOR EXECUTE ON FUNCTIONS FROM anon;" }],
    allowlist: {},
    expect: 0,
  },
  {
    name: "granting the schema default back is refused outright",
    files: [{ name: "a.sql", sql: "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon;" }],
    allowlist: {},
    expect: 1,
  },
  {
    name: "granting the schema default back FOR ROLE is refused too",
    files: [{ name: "a.sql", sql: "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon;" }],
    allowlist: {},
    expect: 1,
  },
  {
    name: "another schema is out of scope",
    files: [{ name: "a.sql", sql: "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA client_platform TO postgres, service_role, authenticated, anon;" }],
    allowlist: {},
    expect: 0,
  },
  {
    name: "blanket grant across public is refused outright",
    files: [{ name: "a.sql", sql: "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon;" }],
    allowlist: {},
    expect: 1,
  },
  {
    name: "an undeclared named grant fails",
    files: [{ name: "a.sql", sql: "GRANT EXECUTE ON FUNCTION public.foo(UUID, TEXT) TO anon;" }],
    allowlist: {},
    expect: 1,
  },
  {
    name: "a declared named grant passes",
    files: [{ name: "a.sql", sql: "GRANT EXECUTE ON FUNCTION public.foo(UUID, TEXT) TO anon;" }],
    allowlist: { "public.foo(uuid,text)": "reason" },
    expect: 0,
  },
  {
    name: "grantee lists are read, not just single roles",
    files: [{ name: "a.sql", sql: "GRANT EXECUTE ON FUNCTION public.foo(uuid) TO authenticated, anon;" }],
    allowlist: {},
    expect: 1,
  },
  {
    name: "TO PUBLIC counts as anon",
    files: [{ name: "a.sql", sql: "GRANT EXECUTE ON FUNCTION public.foo(uuid) TO PUBLIC;" }],
    allowlist: {},
    expect: 1,
  },
  {
    name: "authenticated-only grants are not this gate's business",
    files: [{ name: "a.sql", sql: "GRANT EXECUTE ON FUNCTION public.foo(uuid) TO authenticated;" }],
    allowlist: {},
    expect: 0,
  },
  {
    name: "a later revoke cancels an earlier grant",
    files: [
      { name: "a.sql", sql: "GRANT EXECUTE ON FUNCTION public.foo(uuid) TO anon;" },
      { name: "b.sql", sql: "REVOKE EXECUTE ON FUNCTION public.foo(uuid) FROM anon;" },
    ],
    allowlist: {},
    expect: 0,
  },
  {
    name: "an unsignatured revoke still cancels a signatured grant",
    files: [
      { name: "a.sql", sql: "GRANT EXECUTE ON FUNCTION public.foo(uuid) TO anon;" },
      { name: "b.sql", sql: "REVOKE EXECUTE ON FUNCTION public.foo FROM anon;" },
    ],
    allowlist: {},
    expect: 0,
  },
  {
    name: "a stale allowlist entry fails",
    files: [{ name: "a.sql", sql: "SELECT 1;" }],
    allowlist: { "public.gone(uuid)": "reason" },
    expect: 1,
  },
  {
    name: "a comment describing a grant is not a grant",
    files: [{ name: "a.sql", sql: "-- GRANT EXECUTE ON FUNCTION public.foo(uuid) TO anon;\nSELECT 1;" }],
    allowlist: {},
    expect: 0,
  },
  {
    name: "a function body mentioning anon is not a grant",
    files: [{
      name: "a.sql",
      sql: "CREATE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n  RAISE EXCEPTION 'GRANT EXECUTE ON FUNCTION public.f() TO anon;';\nEND;\n$$;",
    }],
    allowlist: {},
    expect: 0,
  },
];

function selftest() {
  let failed = 0;
  for (const c of CASES) {
    const { granted, hard } = scan(c.files);
    const got = compare(granted, hard, c.allowlist).length;
    if (got !== c.expect) {
      failed += 1;
      console.error(`  FAIL ${c.name}: expected ${c.expect} finding(s), got ${got}`);
    }
  }
  if (failed) {
    console.error(`anon-rpc self-test FAILED: ${failed} of ${CASES.length} case(s).`);
    process.exit(1);
  }
  console.log(`anon-rpc self-test OK: ${CASES.length} parser cases pass.`);
}

/* ----------------------------------------------------------------------- main ------ */

if (process.argv.includes("--selftest")) {
  selftest();
} else if (!existsSync(MIGRATIONS_DIR)) {
  console.log(`skip: no ${MIGRATIONS_DIR} in this repo`);
} else {
  if (!existsSync(ALLOWLIST)) {
    console.error(
      `MISSING: ${ALLOWLIST}\n` +
      `Create it as {"functions": {}}. Empty is the correct starting state: it says no RPC in ` +
      `${GUARDED_SCHEMA} is meant to be callable without a signed-in user.`);
    process.exit(1);
  }

  const allowlist = JSON.parse(readFileSync(ALLOWLIST, "utf8")).functions ?? {};
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ name: f, sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8") }));

  const { granted, hard } = scan(files);
  const fail = compare(granted, hard, allowlist);

  if (fail.length) {
    console.error("anon RPC grant check FAILED:\n" + fail.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  console.log(
    `anon RPC grant OK: ${files.length} migration(s) scanned, ` +
    `${granted.size} declared anon-executable ${GUARDED_SCHEMA} function(s), allowlist agrees. ` +
    `Source scan only: a grant made outside a migration is not visible here. This proves no ` +
    `migration widens the surface, not that the surface is narrow.`);
}
