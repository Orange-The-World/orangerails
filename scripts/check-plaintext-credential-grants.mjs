#!/usr/bin/env node
/**
 * CI gate: our SQL may not leave `anon`, `authenticated` or the PUBLIC pseudo-role holding ANY
 * column applicable privilege on a plaintext credential column, whether by a column grant or by
 * a table wide GRANT.
 *
 * WHY THIS EXISTS. The accepted risk recorded for the plaintext platform credentials is
 * conditional, in its own words: a single table wide GRANT on platforms or apps re-exposes every
 * one of those values at once, the column level grant is the whole control, and a control that
 * depends on nobody typing a table wide GRANT needs a machine watching it. That machine did not
 * exist. The only assertions ever written live inside two migrations, and a migration is applied
 * once and never runs again, so they fired in July and went home. Nothing in CI stands up a
 * Postgres or applies migrations, so nothing re-runs them. This file is the standing check the
 * acceptance names as its condition.
 *
 * WHAT IT GUARDS, exactly (see GUARDED below):
 *   public.platforms.webhook_secret
 *   public.platforms.quiltt_api_key
 *   public.platforms.quiltt_api_key_ciphertext
 *   public.apps.client_secret
 * platforms.api_key_hash and platforms.quiltt_api_key_id are deliberately NOT in that list: a
 * hash and an opaque id are not plaintext credentials. The scoping migration asserts them anyway.
 * Adding either here is one line if that judgement ever changes. connections.strike_webhook_secret
 * is deliberately not here either: it is a separate exposure with its own ticket and is explicitly
 * excluded from this acceptance.
 *
 * WHAT IT CHECKS:
 *   1. Migrations are replayed in filename order and GRANT / REVOKE are folded into an END STATE.
 *      What is judged is what our SQL finally declares, so a grant a later migration takes away
 *      is not a finding.
 *   2. A table wide GRANT on a guarded table is a finding, because a table level privilege covers
 *      every column of the row and no row policy can claw that back.
 *   3. A column GRANT naming a guarded column is a finding.
 *   4. A table level REVOKE clears the column grants too, which is what Postgres does. A COLUMN
 *      level revoke does NOT clear a table level grant, which is also what Postgres does: REVOKE
 *      SELECT (col) against a role that holds the table level privilege is a no-op. That is
 *      precisely why the scoping migration revokes the table grant first and then re-grants the
 *      display columns.
 *   5. GRANT ... ON ALL TABLES IN SCHEMA public counts as a table wide grant on both guarded
 *      tables.
 *   6. Only column applicable privileges count: SELECT, INSERT, UPDATE, REFERENCES. DELETE and
 *      TRUNCATE cannot read or write a column value and are somebody else's argument.
 *
 * IT READS INSIDE DO BLOCKS AND EXECUTE format(), AND THAT IS THE POINT. Every grant in this
 * repository's own scoping migrations is written as EXECUTE format('REVOKE ...', role_name)
 * inside a DO $$ ... $$ block. A scanner built like check-anon-rpc-grants.mjs, which drops dollar
 * quoted bodies whole so that a semicolon inside PL/pgSQL cannot be read as a statement, would
 * scan these migrations and find not one GRANT or REVOKE anywhere, and would report green forever
 * while watching nothing. So string literals and dollar quoted bodies are INLINED here rather than
 * dropped. The cost of that choice is that prose inside a string literal is parsed as SQL, which
 * is the direction that produces a loud false red rather than a quiet false green.
 *
 * AN UNRESOLVED GRANTEE IS TREATED AS EVERY GUARDED ROLE, in both directions: strict on a grant,
 * clearing on a revoke. A format placeholder (%I, %s) or a plpgsql variable in the grantee slot
 * cannot be resolved by a source scan, and the loop those files actually run is over
 * ARRAY['anon','authenticated']. If the statement also names a role literally, for example as the
 * format argument, that literal wins and the placeholder is not expanded.
 *
 * WHAT IT CANNOT SEE, stated here rather than left to be discovered later:
 *   - A GRANT typed straight into a SQL console. It never reaches a migration, so a source scan
 *     cannot see it. Catching that needs a live read of the catalog, which needs a database
 *     credential CI does not hold; check-anon-acl-snapshot.mjs is that other half.
 *   - Privileges INHERITED from schema default privileges rather than written by a migration.
 *     ALTER DEFAULT PRIVILEGES statements are skipped here on purpose: the default ACL on the
 *     public schema is its own tracked piece of work, and folding it in here would make this
 *     gate report on something it cannot actually determine from our SQL.
 *   - Role membership. A grant to some other role that anon is later made a member of is
 *     invisible to a source scan.
 *   - Dynamic SQL whose text is COMPUTED rather than written as a literal. A literal inside
 *     format() is read; a statement assembled by concatenating variables is not.
 *   - A column renamed after this list was written. The names below are matched literally, so a
 *     rename must update GUARDED in the same pull request.
 *
 * SAY IT PLAINLY: THIS GATE PROVES NO MIGRATION RE-EXPOSES THESE COLUMNS. IT DOES NOT PROVE THE
 * LIVE DATABASE IS NARROW. The live half is the catalog snapshot and the database steward's
 * periodic sweep.
 *
 * Run `node scripts/check-plaintext-credential-grants.mjs --selftest` to exercise the parser.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = "supabase/migrations";
const GUARDED_SCHEMA = "public";

/** Table -> the plaintext credential columns on it that no browser facing role may reach. */
const GUARDED = {
  "public.platforms": ["webhook_secret", "quiltt_api_key", "quiltt_api_key_ciphertext"],
  "public.apps": ["client_secret"],
};

/** The grantees this gate cares about. PUBLIC is wider than anon, never narrower. */
const RISKY_GRANTEES = ["anon", "authenticated", "public"];

/**
 * Roles a source scan may resolve and then ignore. Anything NOT in this list and not in
 * RISKY_GRANTEES is treated as unresolved, because a gate that silently ignores a role it does
 * not recognise is a gate with a hole in it. Add a role here deliberately.
 */
const KNOWN_OTHER_ROLES = [
  "postgres",
  "service_role",
  "supabase_admin",
  "supabase_auth_admin",
  "supabase_storage_admin",
  "supabase_read_only_user",
  "authenticator",
  "dashboard_user",
  "pgbouncer",
];

/** Privileges that can apply to a single column. DELETE and TRUNCATE cannot. */
const COLUMN_PRIVS = ["SELECT", "INSERT", "UPDATE", "REFERENCES"];

/* ------------------------------------------------------------------- parsing ------ */

/**
 * Split SQL into statements. Line and block comments are dropped. String literals and dollar
 * quoted bodies are INLINED, not dropped: see the header for why that is the whole point of this
 * file. Adjacent string literals concatenate the way Postgres concatenates them.
 */
export function statements(sql) {
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
      cur += " ";
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { cur += "'"; i += 2; continue; }
        if (sql[i] === "'") { i += 1; break; }
        cur += sql[i];
        i += 1;
      }
      cur += " ";
      continue;
    }
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dollar) {
      // Skip the tag only. The body is then parsed as ordinary SQL, and the closing tag is
      // skipped by this same branch when the walk reaches it.
      i += dollar[0].length;
      cur += " ";
      continue;
    }
    if (sql[i] === ";") { out.push(cur); cur = ""; i += 1; continue; }
    cur += sql[i];
    i += 1;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** Split on a separator that is not inside parentheses. */
function splitTopLevel(s, sep) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Index of a keyword outside parentheses, or -1. Case insensitive, whole word. */
function indexOfKeyword(s, kw) {
  let depth = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "(") { depth += 1; continue; }
    if (ch === ")") { depth = Math.max(0, depth - 1); continue; }
    if (depth !== 0) continue;
    if (s.slice(i, i + kw.length).toUpperCase() !== kw) continue;
    const before = i === 0 ? " " : s[i - 1];
    const after = s[i + kw.length] ?? " ";
    if (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after)) continue;
    return i;
  }
  return -1;
}

const unquote = (name) => name.replace(/"/g, "").toLowerCase();

/** Which guarded tables a target clause names. Non table objects return nothing. */
function targetTables(section) {
  if (/^\s*(FUNCTION|ROUTINE|PROCEDURE|SEQUENCE|SCHEMA|DATABASE|DOMAIN|TYPE|LANGUAGE|TABLESPACE|FOREIGN|LARGE)\b/i.test(section)) {
    return [];
  }
  if (/\bALL\s+(FUNCTIONS|ROUTINES|PROCEDURES|SEQUENCES)\s+IN\s+SCHEMA\b/i.test(section)) return [];
  if (/\bALL\s+TABLES\s+IN\s+SCHEMA\b/i.test(section)) {
    const schema = /\bIN\s+SCHEMA\s+("[^"]+"|[A-Za-z_][A-Za-z0-9_]*)/i.exec(section);
    if (!schema || unquote(schema[1]) !== GUARDED_SCHEMA) return [];
    return Object.keys(GUARDED);
  }
  const body = section.replace(/^\s*TABLE\b/i, " ");
  const found = [];
  for (const part of splitTopLevel(body, ",")) {
    const m = /("[^"]+"|[A-Za-z_][A-Za-z0-9_]*)(?:\.("[^"]+"|[A-Za-z_][A-Za-z0-9_]*))?/.exec(part);
    if (!m) continue;
    const name = m[2] ? `${unquote(m[1])}.${unquote(m[2])}` : `${GUARDED_SCHEMA}.${unquote(m[1])}`;
    if (name in GUARDED) found.push(name);
  }
  return found;
}

/**
 * Which roles a grantee clause names. Returns { roles, unresolved }. A literal role wins over a
 * placeholder in the same clause, because that is the format() argument resolving it.
 */
function granteeRoles(section) {
  const head = section.split(/\bWITH\b|\bCASCADE\b|\bRESTRICT\b|\bGRANTED\s+BY\b/i)[0];
  const roles = new Set();
  let sawUnresolved = false;
  for (const token of splitTopLevel(head, ",")) {
    if (/[%$]/.test(token)) { sawUnresolved = true; continue; }
    const word = unquote(token.replace(/^GROUP\s+/i, "").replace(/[^A-Za-z0-9_"]/g, ""));
    if (!word) continue;
    if (RISKY_GRANTEES.includes(word)) { roles.add(word); continue; }
    if (KNOWN_OTHER_ROLES.includes(word)) { roles.add(word); continue; }
    sawUnresolved = true;
  }
  if (roles.size) return { roles: [...roles], unresolved: false };
  if (sawUnresolved) return { roles: [...RISKY_GRANTEES], unresolved: true };
  return { roles: [], unresolved: false };
}

/** Privileges named by a GRANT or REVOKE, split into table wide and per column. */
function parsePrivs(section) {
  const tableWide = new Set();
  const columns = new Map();
  for (const item of splitTopLevel(section, ",")) {
    const m = /^([A-Za-z][A-Za-z ]*?)\s*(?:\(([^)]*)\))?$/.exec(item);
    if (!m) continue;
    const name = m[1].trim().toUpperCase().replace(/\s+PRIVILEGES$/, "");
    const privs = (name === "ALL" ? [...COLUMN_PRIVS] : [name]).filter((p) => COLUMN_PRIVS.includes(p));
    if (!privs.length) continue;
    if (m[2] === undefined) {
      for (const p of privs) tableWide.add(p);
      continue;
    }
    for (const raw of m[2].split(",")) {
      const col = unquote(raw.trim());
      if (!col) continue;
      if (!columns.has(col)) columns.set(col, new Set());
      for (const p of privs) columns.get(col).add(p);
    }
  }
  return { tableWide, columns };
}

/** Parse one statement into a grant or revoke against guarded tables, or null. */
export function parseStatement(stmt) {
  // Default privileges describe FUTURE objects, not these tables. See the header.
  if (/\bALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(stmt)) return null;
  const kw = /\b(GRANT|REVOKE)\b/i.exec(stmt);
  if (!kw) return null;
  const kind = kw[1].toUpperCase();
  const rest = stmt.slice(kw.index + kw[0].length);
  // REVOKE GRANT OPTION FOR takes away the ability to pass a privilege on. The privilege itself
  // stays exactly where it was, so for this gate the statement changes nothing and the finding
  // it would otherwise have cleared must stand.
  if (kind === "REVOKE" && /^\s*GRANT\s+OPTION\s+FOR\b/i.test(rest)) return null;

  const onAt = indexOfKeyword(rest, "ON");
  if (onAt === -1) return null;
  const privSection = rest.slice(0, onAt);
  const targetSection = rest.slice(onAt + 2);

  const who = kind === "GRANT" ? "TO" : "FROM";
  const whoAt = indexOfKeyword(targetSection, who);
  if (whoAt === -1) return null;

  const tables = targetTables(targetSection.slice(0, whoAt));
  if (!tables.length) return null;

  const { roles, unresolved } = granteeRoles(targetSection.slice(whoAt + who.length));
  if (!roles.length) return null;

  const privs = parsePrivs(privSection);
  if (!privs.tableWide.size && privs.columns.size === 0) return null;

  return { kind, tables, roles, unresolved, privs };
}

/* ---------------------------------------------------------------------- fold ------ */

function entryFor(state, table, role) {
  const key = `${table}|${role}`;
  if (!state.has(key)) state.set(key, { tableWide: new Set(), columns: new Map(), files: new Map() });
  return state.get(key);
}

/**
 * Fold an ordered array of { name, sql } into the end state their SQL declares.
 * Returns a Map keyed `table|role`.
 */
export function scan(files) {
  const state = new Map();
  for (const file of files) {
    for (const stmt of statements(file.sql)) {
      const parsed = parseStatement(stmt);
      if (!parsed) continue;
      for (const table of parsed.tables) {
        for (const role of parsed.roles) {
          const e = entryFor(state, table, role);
          if (parsed.kind === "GRANT") {
            for (const priv of parsed.privs.tableWide) {
              e.tableWide.add(priv);
              e.files.set("TABLE", file.name);
            }
            for (const [col, privs] of parsed.privs.columns) {
              if (!e.columns.has(col)) e.columns.set(col, new Set());
              for (const priv of privs) e.columns.get(col).add(priv);
              e.files.set(`col:${col}`, file.name);
            }
          } else {
            for (const priv of parsed.privs.tableWide) {
              // A table level REVOKE takes the column privileges with it. That is Postgres,
              // not a shortcut here.
              e.tableWide.delete(priv);
              for (const held of e.columns.values()) held.delete(priv);
            }
            for (const [col, privs] of parsed.privs.columns) {
              const held = e.columns.get(col);
              if (!held) continue;
              // Deliberately does NOT touch e.tableWide: a column revoke against a role that
              // holds the table level privilege is a no-op in Postgres.
              for (const priv of privs) held.delete(priv);
            }
          }
        }
      }
    }
  }
  return state;
}

/** Findings, most serious first: a table wide grant, then a column grant. */
export function violations(state) {
  const fail = [];
  for (const [table, cols] of Object.entries(GUARDED)) {
    for (const role of RISKY_GRANTEES) {
      const e = state.get(`${table}|${role}`);
      if (!e) continue;
      if (e.tableWide.size) {
        fail.push(
          `${table}: TABLE WIDE grant of ${[...e.tableWide].sort().join(", ")} to ${role} ` +
          `(${e.files.get("TABLE") ?? "unknown file"}). A table level privilege covers EVERY ` +
          `column of the row, including ${cols.join(", ")}, and no row policy can claw that ` +
          `back. Revoke the table level grant and re-grant only the columns that are safe to ` +
          `expose, which is the shape the scoping migration already uses.`);
        continue;
      }
      for (const col of cols) {
        const held = e.columns.get(col);
        if (!held || held.size === 0) continue;
        fail.push(
          `${table}.${col}: granted ${[...held].sort().join(", ")} to ${role} ` +
          `(${e.files.get(`col:${col}`) ?? "unknown file"}). This column holds a plaintext ` +
          `credential and no browser facing role may hold any privilege on it. Reach it as ` +
          `service_role instead.`);
      }
    }
  }
  return fail;
}

/* ------------------------------------------------------------------ self-test ------ */

const REAL_SHAPE = [
  "DO $$",
  "DECLARE role_name TEXT;",
  "BEGIN",
  "  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP",
  "    EXECUTE format('REVOKE ALL ON TABLE public.platforms FROM %I', role_name);",
  "    EXECUTE format(",
  "      'GRANT SELECT (id, slug, name, display_name, display_brand_color, '",
  "      'widget_url, app_profile_slug, status, env, created_at, updated_at) '",
  "      'ON TABLE public.platforms TO %I', role_name);",
  "  END LOOP;",
  "END",
  "$$;",
].join("\n");

const CASES = [
  {
    name: "a table wide GRANT on platforms is a finding",
    files: [{ name: "a.sql", sql: "GRANT SELECT ON public.platforms TO anon;" }],
    expect: 1,
  },
  {
    name: "a table wide GRANT on apps is a finding",
    files: [{ name: "a.sql", sql: "GRANT ALL ON TABLE public.apps TO authenticated;" }],
    expect: 1,
  },
  {
    name: "a table wide GRANT to PUBLIC is a finding",
    files: [{ name: "a.sql", sql: "GRANT SELECT ON public.platforms TO PUBLIC;" }],
    expect: 1,
  },
  {
    name: "GRANT ON ALL TABLES IN SCHEMA public hits both guarded tables",
    files: [{ name: "a.sql", sql: "GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;" }],
    expect: 2,
  },
  {
    name: "a mixed privilege list with one unscoped privilege is still table wide",
    files: [{ name: "a.sql", sql: "GRANT UPDATE (id), SELECT ON public.platforms TO anon;" }],
    expect: 1,
  },
  {
    name: "a column grant on a guarded column is a finding",
    files: [{ name: "a.sql", sql: "GRANT SELECT (webhook_secret) ON public.platforms TO anon;" }],
    expect: 1,
  },
  {
    name: "a column grant on every guarded column of a table is one finding each",
    files: [{
      name: "a.sql",
      sql: "GRANT SELECT (webhook_secret, quiltt_api_key, quiltt_api_key_ciphertext) ON public.platforms TO anon;",
    }],
    expect: 3,
  },
  {
    name: "a column grant on the display columns passes",
    files: [{ name: "a.sql", sql: "GRANT SELECT (id, slug, name) ON public.platforms TO anon;" }],
    expect: 0,
  },
  {
    name: "a grant to service_role is not this gate's business",
    files: [{ name: "a.sql", sql: "GRANT SELECT ON public.platforms TO service_role;" }],
    expect: 0,
  },
  {
    name: "an unguarded table is out of scope",
    files: [{ name: "a.sql", sql: "GRANT SELECT ON public.connections TO anon;" }],
    expect: 0,
  },
  {
    name: "a table level REVOKE clears an earlier table wide grant",
    files: [
      { name: "a.sql", sql: "GRANT SELECT ON public.platforms TO anon;" },
      { name: "b.sql", sql: "REVOKE ALL ON TABLE public.platforms FROM anon;" },
    ],
    expect: 0,
  },
  {
    name: "a table level REVOKE also clears an earlier column grant",
    files: [
      { name: "a.sql", sql: "GRANT SELECT (webhook_secret) ON public.platforms TO anon;" },
      { name: "b.sql", sql: "REVOKE ALL ON TABLE public.platforms FROM anon;" },
    ],
    expect: 0,
  },
  {
    name: "a COLUMN revoke does NOT clear a table wide grant, because Postgres does not either",
    files: [
      { name: "a.sql", sql: "GRANT SELECT ON public.platforms TO anon;" },
      { name: "b.sql", sql: "REVOKE SELECT (webhook_secret) ON public.platforms FROM anon;" },
    ],
    expect: 1,
  },
  {
    name: "a revoke naming one role leaves the other",
    files: [
      { name: "a.sql", sql: "GRANT SELECT ON public.platforms TO anon, authenticated;" },
      { name: "b.sql", sql: "REVOKE ALL ON public.platforms FROM anon;" },
    ],
    expect: 1,
  },
  {
    name: "a later re-grant after a revoke is a finding again",
    files: [
      { name: "a.sql", sql: "REVOKE ALL ON TABLE public.apps FROM anon;" },
      { name: "b.sql", sql: "GRANT SELECT (client_secret) ON public.apps TO anon;" },
    ],
    expect: 1,
  },
  {
    name: "the shape this repository actually uses passes",
    files: [{ name: "a.sql", sql: REAL_SHAPE }],
    expect: 0,
  },
  {
    name: "a table wide grant hidden inside EXECUTE format is still found",
    files: [{
      name: "a.sql",
      sql: "DO $$\nBEGIN\n  EXECUTE format('GRANT SELECT ON TABLE public.platforms TO %I', 'anon');\nEND\n$$;",
    }],
    expect: 1,
  },
  {
    name: "a guarded column granted inside EXECUTE format is still found",
    files: [{
      name: "a.sql",
      sql: "DO $$\nDECLARE r TEXT;\nBEGIN\n  EXECUTE format('GRANT SELECT (client_secret) ON public.apps TO %I', r);\nEND\n$$;",
    }],
    expect: 3,
  },
  {
    name: "an unresolved grantee resolved by a literal format argument is respected",
    files: [{
      name: "a.sql",
      sql: "DO $$\nBEGIN\n  EXECUTE format('GRANT SELECT ON TABLE public.platforms TO %I', 'service_role');\nEND\n$$;",
    }],
    expect: 0,
  },
  {
    name: "a commented out grant is not a grant",
    files: [{ name: "a.sql", sql: "-- GRANT SELECT ON public.platforms TO anon;\nSELECT 1;" }],
    expect: 0,
  },
  {
    name: "a block commented grant is not a grant",
    files: [{ name: "a.sql", sql: "/* GRANT SELECT ON public.platforms TO anon; */ SELECT 1;" }],
    expect: 0,
  },
  {
    name: "a quoted identifier is matched",
    files: [{ name: "a.sql", sql: 'GRANT SELECT ON "public"."platforms" TO "anon";' }],
    expect: 1,
  },
  {
    name: "an unqualified table name means the public schema",
    files: [{ name: "a.sql", sql: "GRANT SELECT ON platforms TO anon;" }],
    expect: 1,
  },
  {
    name: "DELETE is not a column privilege",
    files: [{ name: "a.sql", sql: "GRANT DELETE ON public.platforms TO anon;" }],
    expect: 0,
  },
  {
    name: "a function grant is not a table grant",
    files: [{ name: "a.sql", sql: "GRANT EXECUTE ON FUNCTION public.platforms(uuid) TO anon;" }],
    expect: 0,
  },
  {
    name: "role membership is not a table grant",
    files: [{ name: "a.sql", sql: "GRANT anon TO authenticator;" }],
    expect: 0,
  },
  {
    name: "default privileges are out of scope here on purpose",
    files: [{ name: "a.sql", sql: "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon;" }],
    expect: 0,
  },
  {
    name: "REVOKE GRANT OPTION FOR is read as a revoke, not a grant",
    files: [
      { name: "a.sql", sql: "GRANT SELECT ON public.platforms TO anon;" },
      { name: "b.sql", sql: "REVOKE GRANT OPTION FOR SELECT ON public.platforms FROM anon;" },
    ],
    expect: 1,
  },
  {
    name: "WITH GRANT OPTION does not break grantee parsing",
    files: [{ name: "a.sql", sql: "GRANT SELECT ON public.platforms TO anon WITH GRANT OPTION;" }],
    expect: 1,
  },
];

function selftest() {
  let failed = 0;
  for (const c of CASES) {
    const got = violations(scan(c.files)).length;
    if (got !== c.expect) {
      failed += 1;
      console.error(`  FAIL ${c.name}: expected ${c.expect} finding(s), got ${got}`);
    }
  }
  if (failed) {
    console.error(`plaintext credential grant self-test FAILED: ${failed} of ${CASES.length} case(s).`);
    process.exit(1);
  }
  console.log(`plaintext credential grant self-test OK: ${CASES.length} parser cases pass.`);
}

/* ----------------------------------------------------------------------- main ------ */

if (process.argv.includes("--selftest")) {
  selftest();
} else if (!existsSync(MIGRATIONS_DIR)) {
  console.error(
    `plaintext credential grant check FAILED: ${MIGRATIONS_DIR} does not exist in this checkout. ` +
    "This gate watches every migration for a re-exposure of a plaintext credential column, and a " +
    "missing migrations directory means it scanned nothing while reporting a status. Fix the " +
    "checkout or the path rather than silently skipping the check.");
  process.exit(1);
} else {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ name: f, sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8") }));

  if (files.length === 0) {
    console.error(
      `plaintext credential grant check FAILED: ${MIGRATIONS_DIR} exists but holds no .sql file. ` +
      "The scoping migrations this gate depends on live there, so an empty directory means this " +
      "run scanned zero migrations, not zero violations. Fix the checkout rather than let this go " +
      "green on nothing.");
    process.exit(1);
  }

  const fail = violations(scan(files));
  const guardedColumns = Object.values(GUARDED).reduce((n, cols) => n + cols.length, 0);

  if (fail.length) {
    console.error(
      "plaintext credential grant check FAILED:\n" + fail.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  console.log(
    `plaintext credential grant OK: ${files.length} migration(s) scanned, ${guardedColumns} ` +
    `guarded column(s) across ${Object.keys(GUARDED).length} table(s), no privilege left to ` +
    `${RISKY_GRANTEES.join(", ")}. Source scan only: a grant made outside a migration, or ` +
    `inherited from schema default privileges, is not visible here.`);
}
