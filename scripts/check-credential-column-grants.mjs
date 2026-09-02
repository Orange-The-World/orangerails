#!/usr/bin/env node
/**
 * CI gate: our SQL may not leave the `anon` or `authenticated` roles, or the PUBLIC
 * pseudo-role, holding ANY privilege on a server side credential column, and may not hand
 * those roles a table wide grant on a table that carries one.
 *
 * WHY THIS EXISTS. Two migrations already assert this end state, and they assert it well:
 * 20260713160000_platforms_column_grants.sql and
 * 20260713120001_apps_client_secret_column_grants.sql each end in a DO block that fails the
 * migration if a browser facing role can reach one of these columns. What they cannot do is
 * keep asserting it. A migration is applied once and never runs again, and no job in this
 * workflow stands up a Postgres and replays migrations, so those assertions fired the day they
 * landed and will never fire again. A control that has already fired and gone home is not a
 * control. This file is the same invariant as a standing check that runs on every pull
 * request, against our SQL rather than against a database.
 *
 * THE RULE IT ENCODES, which is the one the two migrations spell out at length:
 *
 *   RLS decides WHICH ROWS a role can see.
 *   Grants decide WHICH COLUMNS.
 *
 * A table level GRANT covers every column of the row, credential column included, and no
 * policy can claw that back. Postgres also cannot subtract one column from a table level
 * grant: REVOKE SELECT (col) against a role that holds the table level privilege is a no-op.
 * That is why a single table wide GRANT undoes all of this work in one statement, and why it
 * is the thing this gate is here to catch.
 *
 * WHAT IT CHECKS, exactly:
 *   1. Migrations are replayed in filename order and GRANT / REVOKE are folded into an END
 *      STATE. What is judged is what our SQL finally declares, so a grant that a later
 *      migration takes away is fine.
 *   2. A table wide GRANT on a guarded table to a browser facing role fails, whatever the
 *      privilege. Read and write both: a write grant left standing is harmless only for as
 *      long as no permissive write policy exists.
 *   3. A column level GRANT naming a guarded column fails.
 *   4. GRANT ... ON ALL TABLES IN SCHEMA public, and ALTER DEFAULT PRIVILEGES ... GRANT ...
 *      ON TABLES IN SCHEMA public, are refused outright. The first reaches the guarded tables
 *      today; the second reaches any guarded table that is ever recreated. Neither can be
 *      written narrowly, so neither is expressible as an exception.
 *   5. A column level REVOKE does NOT cancel a table wide GRANT, because in Postgres it does
 *      not. The fold models the database rather than flattering us.
 *   6. Dynamic SQL is read, wherever it sits. Both migrations above run their GRANT and REVOKE
 *      inside DO blocks as EXECUTE format(...), so a parser that drops dollar quoted bodies
 *      sees an empty file and reports green over a read that found nothing.
 *
 * WHAT IT CANNOT SEE. Four real blind spots, written here rather than only in the pull
 * request, because a control that appears to cover more than it does is what stops anyone
 * from looking at the rest.
 *
 *   First, it reads our SQL, not the live database. A GRANT typed straight into a SQL console
 *   never reaches a migration and is invisible here. Catching that needs a live read of the
 *   catalog, which needs a database credential CI does not hold.
 *   scripts/check-anon-acl-snapshot.mjs is that other half, and note that only its selftest
 *   runs in this workflow: the check itself runs against a catalog snapshot outside it.
 *
 *   Second, a grantee computed at runtime cannot be resolved to a role name. A dynamic GRANT
 *   is therefore treated as if it named every browser facing role, so it fails; a dynamic
 *   REVOKE is treated as if it cleared every one of them, so it passes. The second half is the
 *   generous direction and it is deliberate, because it is the shape both existing migrations
 *   use (REVOKE ALL ... FROM %I inside a FOREACH over anon and authenticated). A dynamic
 *   revoke that really only cleared one role would be over-credited here.
 *
 *   Third, it says nothing about RLS, about whether service_role should hold what it holds, or
 *   about how these values are stored. It is about which columns a browser facing role can
 *   reach, and nothing else.
 *
 *   Fourth, column names are matched literally against the GUARDED table below. Renaming a
 *   guarded column, or adding a new credential column to one of these tables, needs that table
 *   updated by hand. Nothing detects it for you, and a rename would silently narrow this gate.
 *
 * Deliberately out of scope: public.connections.strike_webhook_secret, which is a separate
 * exposure tracked on its own ticket and is excluded by the accepted risk record this gate
 * backs. Do not fold it in here without reading that record first.
 *
 * Run `node scripts/check-credential-column-grants.mjs --selftest` to exercise the parser
 * itself. The parser IS the control, so it is tested rather than trusted.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = "supabase/migrations";
const GUARDED_SCHEMA = "public";

/**
 * The columns a browser facing role must hold nothing on, by table. This list is the one the
 * two column-grant migrations assert on, and it is deliberately wider than the accepted risk
 * record's own list: api_key_hash and quiltt_api_key_id are server side values too, and
 * guarding them costs nothing.
 */
const GUARDED = {
  "public.platforms": [
    "webhook_secret",
    "api_key_hash",
    "quiltt_api_key",
    "quiltt_api_key_ciphertext",
    "quiltt_api_key_id",
  ],
  "public.apps": ["client_secret"],
};

/** Where to point a reader when a table's shape regresses. */
const REFERENCE_MIGRATION = {
  "public.platforms": "20260713160000_platforms_column_grants.sql",
  "public.apps": "20260713120001_apps_client_secret_column_grants.sql",
};

/** The grantees this gate cares about. PUBLIC is wider than anon, never narrower. */
const RISKY_GRANTEES = ["anon", "authenticated", "public"];

const PRIVILEGE_WORD =
  "SELECT|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|MAINTAIN|ALL";

/**
 * Flatten SQL into something statement splitting can work on:
 *   - line and block comments are removed, so a commented out grant is not a grant;
 *   - dollar quote tags are removed but their BODIES ARE KEPT, so the inside of a DO block is
 *     read as SQL;
 *   - single quotes are removed but their contents are kept, so
 *     EXECUTE format('GRANT ... ' 'ON TABLE ... TO %I') reads as the statement it builds.
 *
 * Quote characters are deleted rather than tracked as string state on purpose: an apostrophe
 * inside a RAISE message would otherwise unbalance the parse and swallow the rest of the file,
 * and silently reading less than the whole input is the exact failure mode this gate exists to
 * end. The cost of that choice, stated plainly: prose inside a string that spells out a
 * complete GRANT statement, positioned where a statement may legally begin, is read as that
 * statement. It fails loudly and the fix is to reword the prose.
 */
export function flatten(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      out += " ";
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
      out += " ";
      continue;
    }
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dollar) { out += " "; i += dollar[0].length; continue; }
    if (sql[i] === "'") { out += " "; i += 1; continue; }
    out += sql[i];
    i += 1;
  }
  return out;
}

/** Split flattened SQL into single line chunks. A chunk is not yet a statement. */
export function chunks(sql) {
  return flatten(sql)
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * The contexts a statement may legally begin in, other than the start of a chunk. Splitting a
 * DO block on semicolons leaves the interesting statement in the middle of the chunk, because
 * the DECLARE section ended with the semicolon: the chunk reads
 * `BEGIN FOREACH ... LOOP EXECUTE format( REVOKE ALL ...`. Anchoring to the chunk start reads
 * half the file and reports on the half it read.
 */
const STATEMENT_CONTEXT = /(?:\b(?:EXECUTE|BEGIN|LOOP|THEN|ELSE|DO|END)\s*$)|\(\s*$/i;

/** Every place in a chunk where a statement this gate cares about actually starts. */
export function starts(chunk) {
  const out = [];
  const re = /\b(?:GRANT|REVOKE|ALTER)\b/gi;
  let match;
  while ((match = re.exec(chunk)) !== null) {
    const before = chunk.slice(0, match.index);
    // `REVOKE GRANT OPTION FOR ...` must not be read as a GRANT: the word is preceded by
    // REVOKE, which is not a place a statement begins.
    if (before.trim() === "" || STATEMENT_CONTEXT.test(before)) out.push(chunk.slice(match.index));
  }
  return out;
}

/** Everything after the last standalone occurrence of a keyword, or null. */
function tailAfter(stmt, keyword) {
  const re = new RegExp(`\\b${keyword}\\b`, "gi");
  let match;
  let end = -1;
  while ((match = re.exec(stmt)) !== null) end = match.index + match[0].length;
  return end === -1 ? null : stmt.slice(end);
}

/**
 * Which browser facing roles a grantee list reaches. `dynamic` means the list carries a format
 * placeholder, so the real grantee is not knowable from the source; see the header for how
 * that is treated in each direction.
 */
export function grantees(tail) {
  if (tail === null) return { roles: [], dynamic: false };
  const clean = tail.replace(/"/g, "");
  const dynamic = /%[IsL]/.test(clean);
  const roles = RISKY_GRANTEES.filter((role) =>
    new RegExp(`(^|[\\s,(])${role}(\\s|,|\\)|$)`, "i").test(clean));
  return { roles: dynamic ? [...RISKY_GRANTEES] : roles, dynamic };
}

const unquote = (s) => s.replace(/"/g, "").toLowerCase();

/** public.platforms from `platforms`, `public.platforms` or `"public"."platforms"`. */
function tableKey(part1, part2) {
  const first = unquote(part1);
  return part2 ? `${first}.${unquote(part2)}` : `${GUARDED_SCHEMA}.${first}`;
}

/**
 * Read a privilege clause: which named columns it carries, and whether any privilege in it is
 * table wide, that is, written without a column list.
 */
export function privileges(clause) {
  const columns = new Set();
  const rest = clause.replace(
    new RegExp(`\\b(?:${PRIVILEGE_WORD})(?:\\s+PRIVILEGES)?\\s*\\(([^)]*)\\)`, "gi"),
    (_match, list) => {
      for (const raw of list.split(",")) {
        const name = unquote(raw.trim());
        if (name) columns.add(name);
      }
      return " ";
    });
  return { columns, tableWide: new RegExp(`\\b(?:${PRIVILEGE_WORD})\\b`, "i").test(rest) };
}

function entryFor(state, table, role) {
  const key = `${table}|${role}`;
  if (!state.has(key)) state.set(key, { wide: null, columns: new Map() });
  return state.get(key);
}

/**
 * Fold an ordered array of { name, sql } into the end state the SQL declares.
 * Returns { state, hard }: `state` maps `table|role` to what that role is left holding, and
 * `hard` holds findings no end state can excuse.
 */
export function scan(files) {
  const state = new Map();
  const hard = [];

  const allTablesRe = /\bON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+("?[A-Za-z_][A-Za-z0-9_]*"?)/i;
  const tableRe =
    /\bON\s+(?:TABLE\s+)?("[^"]+"|[A-Za-z_][A-Za-z0-9_]*)(?:\s*\.\s*("[^"]+"|[A-Za-z_][A-Za-z0-9_]*))?/i;

  for (const file of files) {
    for (const chunk of chunks(file.sql)) {
      for (const stmt of starts(chunk)) {
        if (/^ALTER\b/i.test(stmt)) {
          if (!/^ALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(stmt)) continue;
          if (!/\bON\s+TABLES\b/i.test(stmt)) continue;
          const schema = /\bIN\s+SCHEMA\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(stmt);
          if (!schema || schema[1].toLowerCase() !== GUARDED_SCHEMA) continue;
          // A REVOKE of the schema default is the durable fix and passes. Only the widening
          // direction is refused, and REVOKE GRANT OPTION FOR reads as the revoke it is.
          if (!/^ALTER\s+DEFAULT\s+PRIVILEGES\b(?:(?!\bREVOKE\b).)*\bGRANT\b/i.test(stmt)) continue;
          const who = grantees(tailAfter(stmt, "TO"));
          if (who.roles.length) {
            hard.push(
              `${file.name}: ALTER DEFAULT PRIVILEGES grants on future ${GUARDED_SCHEMA} ` +
              `tables to ${who.roles.join(", ")}. Any guarded table recreated after this is ` +
              `born with a table wide grant covering its credential column. Not expressible ` +
              `as an exception: grant the exact columns on the exact table instead.`);
          }
          continue;
        }

        const isGrant = /^GRANT\b/i.test(stmt);
        const isRevoke = /^REVOKE\b/i.test(stmt);
        if (!isGrant && !isRevoke) continue;

        const who = grantees(tailAfter(stmt, isGrant ? "TO" : "FROM"));
        if (!who.roles.length) continue;

        const onIndex = stmt.search(/\bON\b/i);
        if (onIndex === -1) continue;
        const clause = stmt
          .slice(0, onIndex)
          .replace(/^(?:GRANT|REVOKE)\b/i, "")
          .replace(/^\s*GRANT\s+OPTION\s+FOR\b/i, "");
        const { columns, tableWide } = privileges(clause);

        const blanket = allTablesRe.exec(stmt);
        if (blanket) {
          if (unquote(blanket[1]) !== GUARDED_SCHEMA) continue;
          if (isGrant) {
            hard.push(
              `${file.name}: blanket GRANT ON ALL TABLES IN SCHEMA ${GUARDED_SCHEMA} to ` +
              `${who.roles.join(", ")}. That covers every guarded table at once, and a table ` +
              `wide grant covers every column of the row including the credential column. Not ` +
              `expressible as an exception: name the table and the columns.`);
          } else {
            for (const table of Object.keys(GUARDED)) {
              for (const role of who.roles) {
                const entry = entryFor(state, table, role);
                entry.wide = null;
                entry.columns.clear();
              }
            }
          }
          continue;
        }

        const target = tableRe.exec(stmt);
        if (!target) continue;
        const table = tableKey(target[1], target[2]);
        if (!GUARDED[table]) continue;

        for (const role of who.roles) {
          const entry = entryFor(state, table, role);
          if (isGrant) {
            if (tableWide) entry.wide = file.name;
            for (const column of columns) {
              if (GUARDED[table].includes(column)) entry.columns.set(column, file.name);
            }
          } else if (tableWide) {
            // A table wide REVOKE takes the lot, which is why both migrations open with
            // REVOKE ALL before re-granting the display columns.
            entry.wide = null;
            entry.columns.clear();
          } else {
            // A column level REVOKE does NOT clear a table level grant: Postgres treats it as
            // a no-op against a role holding the table privilege. Modelling that faithfully is
            // the point, because assuming otherwise is the exact mistake these migrations
            // exist to correct.
            for (const column of columns) entry.columns.delete(column);
          }
        }
      }
    }
  }

  return { state, hard };
}

/** Turn the end state into failures. Returns an array of strings. */
export function compare(state, hard) {
  const fail = [...hard];
  for (const [key, entry] of state) {
    const [table, role] = key.split("|");
    if (entry.wide) {
      fail.push(
        `${table}: table wide grant to ${role} in ${entry.wide}. A table level grant covers ` +
        `every column of the row, so it re-exposes ${GUARDED[table].join(", ")} in one ` +
        `statement, and no RLS policy can claw that back. Revoke it and re-grant the exact ` +
        `display columns, as ${REFERENCE_MIGRATION[table]} does.`);
      continue;
    }
    for (const [column, where] of entry.columns) {
      fail.push(
        `${table}.${column}: granted to ${role} in ${where}. This column is server side only ` +
        `and browser facing roles must hold nothing on it, in any mode. Revoke the grant, ` +
        `naming every grantee it was given to.`);
    }
  }
  return fail;
}

/* ------------------------------------------------------------------ self-test ------ */

const CASES = [
  {
    name: "the shape both real migrations use folds to nothing",
    files: [{
      name: "a.sql",
      sql:
        "DO $$\nDECLARE role_name TEXT;\nBEGIN\n" +
        "  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP\n" +
        "    EXECUTE format('REVOKE ALL ON TABLE public.apps FROM %I', role_name);\n" +
        "    EXECUTE format(\n" +
        "      'GRANT SELECT (id, slug, name, description) '\n" +
        "      'ON TABLE public.apps TO %I', role_name);\n" +
        "  END LOOP;\nEND\n$$;",
    }],
    expect: 0,
  },
  {
    name: "a revoke buried mid chunk after BEGIN FOREACH is still read",
    files: [
      { name: "a.sql", sql: "GRANT SELECT ON public.platforms TO anon;" },
      {
        name: "b.sql",
        sql:
          "DO $$\nDECLARE role_name TEXT;\nBEGIN\n" +
          "  FOREACH role_name IN ARRAY ARRAY['anon'] LOOP\n" +
          "    EXECUTE format('REVOKE ALL ON TABLE public.platforms FROM %I', role_name);\n" +
          "  END LOOP;\nEND\n$$;",
      },
    ],
    expect: 0,
  },
  {
    name: "a dynamic table wide grant buried mid chunk fails",
    files: [{
      name: "a.sql",
      sql: "DO $$ BEGIN EXECUTE format('GRANT SELECT ON TABLE public.platforms TO %I', r); END $$;",
    }],
    expect: 1,
  },
  {
    name: "a table wide grant to anon fails",
    files: [{ name: "a.sql", sql: "GRANT SELECT ON TABLE public.platforms TO anon;" }],
    expect: 1,
  },
  {
    name: "a table wide grant to authenticated fails",
    files: [{ name: "a.sql", sql: "GRANT SELECT ON public.apps TO authenticated;" }],
    expect: 1,
  },
  {
    name: "a table wide grant to PUBLIC fails",
    files: [{ name: "a.sql", sql: "GRANT ALL ON public.platforms TO PUBLIC;" }],
    expect: 1,
  },
  {
    name: "an unqualified table name is read as public",
    files: [{ name: "a.sql", sql: "GRANT SELECT ON apps TO anon;" }],
    expect: 1,
  },
  {
    name: "quoted identifiers are read",
    files: [{ name: "a.sql", sql: 'GRANT SELECT ON "public"."platforms" TO anon;' }],
    expect: 1,
  },
  {
    name: "a column grant naming a guarded column fails",
    files: [{ name: "a.sql", sql: "GRANT SELECT (webhook_secret) ON public.platforms TO anon;" }],
    expect: 1,
  },
  {
    name: "a mixed privilege list is read column by column",
    files: [{
      name: "a.sql",
      sql: "GRANT SELECT (slug), UPDATE (quiltt_api_key) ON public.platforms TO authenticated;",
    }],
    expect: 1,
  },
  {
    name: "a column grant on display columns only passes",
    files: [{ name: "a.sql", sql: "GRANT SELECT (id, slug, name) ON public.platforms TO anon;" }],
    expect: 0,
  },
  {
    name: "a write grant counts, not just SELECT",
    files: [{ name: "a.sql", sql: "GRANT UPDATE ON public.apps TO anon;" }],
    expect: 1,
  },
  {
    name: "a later table wide revoke cancels an earlier table wide grant",
    files: [
      { name: "a.sql", sql: "GRANT SELECT ON public.platforms TO anon;" },
      { name: "b.sql", sql: "REVOKE ALL ON TABLE public.platforms FROM anon;" },
    ],
    expect: 0,
  },
  {
    name: "a revoke naming both roles clears both",
    files: [
      { name: "a.sql", sql: "GRANT SELECT ON public.apps TO anon, authenticated;" },
      { name: "b.sql", sql: "REVOKE ALL ON public.apps FROM anon, authenticated;" },
    ],
    expect: 0,
  },
  {
    name: "a revoke naming one role leaves the other standing",
    files: [
      { name: "a.sql", sql: "GRANT SELECT ON public.apps TO anon, authenticated;" },
      { name: "b.sql", sql: "REVOKE ALL ON public.apps FROM anon;" },
    ],
    expect: 1,
  },
  {
    name: "a column revoke does NOT cancel a table wide grant, as in Postgres",
    files: [
      { name: "a.sql", sql: "GRANT SELECT ON public.apps TO anon;" },
      { name: "b.sql", sql: "REVOKE SELECT (client_secret) ON public.apps FROM anon;" },
    ],
    expect: 1,
  },
  {
    name: "a column revoke does cancel a column grant",
    files: [
      { name: "a.sql", sql: "GRANT SELECT (client_secret) ON public.apps TO anon;" },
      { name: "b.sql", sql: "REVOKE SELECT (client_secret) ON public.apps FROM anon;" },
    ],
    expect: 0,
  },
  {
    name: "REVOKE GRANT OPTION FOR is read as the revoke it is",
    files: [
      { name: "a.sql", sql: "GRANT SELECT ON public.apps TO anon;" },
      { name: "b.sql", sql: "REVOKE GRANT OPTION FOR ALL ON public.apps FROM anon;" },
    ],
    expect: 0,
  },
  {
    name: "a blanket grant across the schema is refused outright",
    files: [{ name: "a.sql", sql: "GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;" }],
    expect: 1,
  },
  {
    name: "a blanket grant in another schema is out of scope",
    files: [{
      name: "a.sql",
      sql: "GRANT SELECT ON ALL TABLES IN SCHEMA client_platform TO anon;",
    }],
    expect: 0,
  },
  {
    name: "a blanket revoke across the schema clears the guarded tables",
    files: [
      { name: "a.sql", sql: "GRANT SELECT ON public.platforms TO anon;" },
      { name: "b.sql", sql: "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;" },
    ],
    expect: 0,
  },
  {
    name: "widening the schema default is refused outright",
    files: [{
      name: "a.sql",
      sql: "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;",
    }],
    expect: 1,
  },
  {
    name: "revoking the schema default is the fix, not a failure",
    files: [{
      name: "a.sql",
      sql: "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM anon;",
    }],
    expect: 0,
  },
  {
    name: "the schema default on FUNCTIONS is another gate's business",
    files: [{
      name: "a.sql",
      sql: "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon;",
    }],
    expect: 0,
  },
  {
    name: "the schema default in another schema is out of scope",
    files: [{
      name: "a.sql",
      sql: "ALTER DEFAULT PRIVILEGES IN SCHEMA client_platform GRANT SELECT ON TABLES TO anon;",
    }],
    expect: 0,
  },
  {
    name: "service_role is untouched by this gate",
    files: [{ name: "a.sql", sql: "GRANT ALL ON public.platforms TO service_role;" }],
    expect: 0,
  },
  {
    name: "another table is out of scope, including the one tracked separately",
    files: [{ name: "a.sql", sql: "GRANT SELECT ON public.connections TO anon;" }],
    expect: 0,
  },
  {
    name: "a function grant is another gate's business",
    files: [{ name: "a.sql", sql: "GRANT EXECUTE ON FUNCTION public.foo(uuid) TO anon;" }],
    expect: 0,
  },
  {
    name: "a commented out grant is not a grant",
    files: [{
      name: "a.sql",
      sql:
        "-- GRANT SELECT ON public.platforms TO anon;\n" +
        "/* GRANT SELECT ON public.apps TO anon; */\nSELECT 1;",
    }],
    expect: 0,
  },
  {
    name: "a rollback note in trailing comments is not a grant",
    files: [{
      name: "a.sql",
      sql:
        "SELECT 1;\n--   REVOKE ALL ON TABLE public.apps FROM anon, authenticated;\n" +
        "--   GRANT SELECT, INSERT ON TABLE public.apps TO anon, authenticated;\n",
    }],
    expect: 0,
  },
  {
    name: "a RAISE message quoting a grant is not a grant",
    files: [{
      name: "a.sql",
      sql: "DO $$ BEGIN RAISE EXCEPTION 'do not GRANT SELECT ON public.apps TO anon'; END $$;",
    }],
    expect: 0,
  },
  {
    name: "a COMMENT ON COLUMN saying none may be granted is not a grant",
    files: [{
      name: "a.sql",
      sql:
        "COMMENT ON COLUMN public.apps.client_secret IS 'Server side only: anon and " +
        "authenticated hold no privilege on this column, and none may be granted.';",
    }],
    expect: 0,
  },
];

function selftest() {
  let failed = 0;
  for (const testCase of CASES) {
    const { state, hard } = scan(testCase.files);
    const got = compare(state, hard).length;
    if (got !== testCase.expect) {
      failed += 1;
      console.error(`  FAIL ${testCase.name}: expected ${testCase.expect} finding(s), got ${got}`);
    }
  }
  if (failed) {
    console.error(`credential grant self-test FAILED: ${failed} of ${CASES.length} case(s).`);
    process.exit(1);
  }
  console.log(`credential grant self-test OK: ${CASES.length} parser cases pass.`);
}

/* ----------------------------------------------------------------------- main ------ */

if (process.argv.includes("--selftest")) {
  selftest();
} else if (!existsSync(MIGRATIONS_DIR)) {
  console.log(`skip: no ${MIGRATIONS_DIR} in this repo`);
} else {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ name: f, sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8") }));

  if (files.length === 0) {
    console.error(
      `MISSING: ${MIGRATIONS_DIR} holds no .sql files. A scan of nothing passes for free, ` +
      `which is the outcome this line exists to refuse.`);
    process.exit(1);
  }

  const { state, hard } = scan(files);
  const fail = compare(state, hard);

  if (fail.length) {
    console.error(
      "credential column grant check FAILED:\n" + fail.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }

  const guardedColumns = Object.values(GUARDED).reduce((n, cols) => n + cols.length, 0);
  console.log(
    `credential column grant OK: ${files.length} migration(s) scanned, ` +
    `${guardedColumns} guarded column(s) across ${Object.keys(GUARDED).length} table(s), ` +
    `no browser facing role is left holding a privilege on any of them. Source scan only: a ` +
    `grant made outside a migration is not visible here. This proves no migration widens the ` +
    `surface, not that the live database is narrow.`);
}
