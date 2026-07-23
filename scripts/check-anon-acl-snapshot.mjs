#!/usr/bin/env node
/**
 * Check a snapshot of live catalog ACLs for privileges held by the unauthenticated
 * surface. Companion to `check-anon-rpc-grants.mjs`, which reads our SQL. The two
 * answer different questions and neither replaces the other:
 *
 *   check-anon-rpc-grants.mjs  no migration of ours WIDENS the surface
 *   this file                  the surface as it stands on a real database IS narrow
 *
 * The second question cannot be answered from the repo. On this project the grants
 * that matter were never written by a migration: they are inherited from the schema
 * default privileges, and a GRANT typed straight into a SQL console never reaches a
 * migration either. Only the catalog knows.
 *
 * WHY THIS IS NOT A NAME MATCH. Postgres does not write the PUBLIC pseudo role by
 * name in an ACL. It writes an EMPTY GRANTEE:
 *
 *     =X/postgres                  PUBLIC holds EXECUTE, granted by postgres
 *     anon=X/postgres              the anon role holds EXECUTE
 *     postgres=X* /postgres        postgres holds EXECUTE with grant option. The space
 *                                  before the slash is NOT part of the real ACL: a star
 *                                  immediately followed by a slash closes this comment
 *                                  block, and everything below would stop being a
 *                                  comment and start being broken source.
 *
 * Match on role names alone and every function held the first way reads green. The
 * second trap is worse, because it looks like nothing at all: a function whose
 * `proacl` IS NULL has never had its privileges touched, and the Postgres default
 * for a function is EXECUTE to PUBLIC. The emptiest looking row is an open one.
 *
 * INPUT. CI holds no database credential, so this does not connect to anything. It
 * reads a snapshot file refreshed by the database steward. Either shape is accepted:
 *
 *   JSON   [ { "object": "public.foo(uuid)", "kind": "function", "acl": "{=X/postgres}" } ]
 *   text   public.foo(uuid)  {=X/postgres}          (one object per line)
 *
 * In the text shape the object name is everything before the first `{`, and a line
 * whose ACL column is empty or the word NULL is read as a NULL acl, which for a
 * function is the open case above, not a clean one.
 *
 * ALLOWLIST. Shared with the source gate: `supabase/anon-executable-rpcs.json`. An
 * object listed there may be reached by the unauthenticated surface on purpose. A
 * stale entry is not an error here, because a snapshot is a point in time and the
 * source gate already owns that check.
 *
 * Run `node scripts/check-anon-acl-snapshot.mjs --selftest` to exercise the parser,
 * and `node scripts/check-anon-acl-snapshot.mjs <snapshot-file>` to check a snapshot.
 */

import { readFileSync, existsSync } from "node:fs";

const ALLOWLIST = "supabase/anon-executable-rpcs.json";

/** Grantees that mean "reachable without a signed in user", plus the one that means
 *  "reachable by any signed in user". Both are findings: the first is the anonymous
 *  surface, the second is every account on the platform. PUBLIC is wider than either,
 *  because every role inherits it. */
const RISKY = new Set(["PUBLIC", "anon", "authenticated"]);

/** Privilege letters we care about. X is EXECUTE on a function. r/w/a/d are the table
 *  side, carried because relacl snapshots go through the same parser. */
const PRIV_NAMES = { r: "SELECT", w: "UPDATE", a: "INSERT", d: "DELETE", X: "EXECUTE" };

/**
 * Split a Postgres ACL array literal into its items. Items may be quoted, and a quoted
 * item may contain a comma, so this is a scan rather than a split on ",".
 */
export function aclItems(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text === "" || text.toUpperCase() === "NULL") return null;
  const inner = text.replace(/^\{/, "").replace(/\}$/, "");
  if (inner.trim() === "") return [];
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "\\" && quoted) { cur += inner[i + 1] ?? ""; i += 1; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === "," && !quoted) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Parse one ACL item into { grantee, privileges }. An item is grantee=privs/grantor,
 * and an EMPTY grantee is the PUBLIC pseudo role. Grant option markers (`X*`) are
 * stripped from the privilege letters: holding EXECUTE with grant option is still
 * holding EXECUTE, and reading the star as a letter would lose it.
 */
export function parseAclItem(item) {
  const eq = item.indexOf("=");
  if (eq === -1) return null;
  const grantee = item.slice(0, eq).trim().replace(/^"|"$/g, "");
  const slash = item.indexOf("/", eq);
  const privs = item.slice(eq + 1, slash === -1 ? undefined : slash).replace(/\*/g, "");
  return { grantee: grantee === "" ? "PUBLIC" : grantee, privileges: privs };
}

/** Human names for a privilege string, unknown letters passed through as themselves. */
const describe = (privs) =>
  [...new Set(privs.split(""))].map((c) => PRIV_NAMES[c] ?? c).join(", ");

/**
 * Check one snapshot row. Returns an array of finding strings.
 * A row is { object, kind, acl }. kind defaults to "function".
 */
export function checkRow(row, allowed) {
  const object = String(row.object ?? "").trim();
  const kind = (row.kind ?? "function").toLowerCase();
  const items = aclItems(row.acl);
  const findings = [];

  if (items === null) {
    // NULL acl means the object still carries the built in default. For a function
    // that default is EXECUTE to PUBLIC, so this is the open case, not a clean one.
    if (kind === "function" && !allowed.has(object)) {
      findings.push(
        `${object}: acl is NULL, so no GRANT or REVOKE has ever touched this function ` +
        `and the built in default stands: PUBLIC holds EXECUTE. Revoke it, or add ` +
        `"${object}" to ${ALLOWLIST} with a one line reason.`);
    }
    return findings;
  }

  for (const item of items) {
    const parsed = parseAclItem(item);
    if (!parsed) continue;
    if (!RISKY.has(parsed.grantee)) continue;
    if (!parsed.privileges) continue;
    if (allowed.has(object)) continue;
    const who = parsed.grantee === "PUBLIC"
      ? "PUBLIC (the empty grantee, which every role inherits)"
      : parsed.grantee;
    findings.push(
      `${object}: ${who} holds ${describe(parsed.privileges)} (acl item \`${item}\`). ` +
      `Revoke it, naming that grantee: a REVOKE FROM anon does not touch a PUBLIC ` +
      `grant and the reverse is equally true. If the access is intended, add ` +
      `"${object}" to ${ALLOWLIST} with a one line reason.`);
  }
  return findings;
}

/** Check a whole snapshot. `rows` is an array of { object, kind, acl }. */
export function checkSnapshot(rows, allowlist) {
  const allowed = new Set(Object.keys(allowlist ?? {}));
  return rows.flatMap((row) => checkRow(row, allowed));
}

/**
 * Read a snapshot file in either accepted shape. Text lines are split at the first
 * `{`, so an object name containing a space or a signature survives intact.
 */
export function parseSnapshot(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : (parsed.rows ?? []);
  }
  return trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("--") && !line.startsWith("#"))
    .map((line) => {
      const brace = line.indexOf("{");
      if (brace === -1) return { object: line.replace(/\s+NULL$/i, "").trim(), acl: null };
      return { object: line.slice(0, brace).trim(), acl: line.slice(brace).trim() };
    });
}

/* ------------------------------------------------------------------ self-test ------ */

const CASES = [
  {
    name: "an empty grantee is PUBLIC and fails",
    rows: [{ object: "public.foo(uuid)", acl: "{=X/postgres}" }],
    allowlist: {},
    expect: 1,
  },
  {
    name: "an empty grantee fails even when named roles look clean",
    rows: [{ object: "public.foo(uuid)", acl: "{=X/postgres,postgres=X/postgres,service_role=X/postgres}" }],
    allowlist: {},
    expect: 1,
  },
  {
    name: "owner and service_role alone are clean",
    rows: [{ object: "public.foo(uuid)", acl: "{postgres=X/postgres,service_role=X/postgres}" }],
    allowlist: {},
    expect: 0,
  },
  {
    name: "a named anon grant fails",
    rows: [{ object: "public.foo(uuid)", acl: "{postgres=X/postgres,anon=X/postgres}" }],
    allowlist: {},
    expect: 1,
  },
  {
    name: "a named authenticated grant fails",
    rows: [{ object: "public.foo(uuid)", acl: "{authenticated=X/postgres}" }],
    allowlist: {},
    expect: 1,
  },
  {
    name: "anon and PUBLIC on one object are two findings, not one",
    rows: [{ object: "public.foo(uuid)", acl: "{=X/postgres,anon=X/postgres}" }],
    allowlist: {},
    expect: 2,
  },
  {
    name: "a NULL acl on a function is PUBLIC EXECUTE by default, not clean",
    rows: [{ object: "public.foo(uuid)", kind: "function", acl: null }],
    allowlist: {},
    expect: 1,
  },
  {
    name: "the literal string NULL is read the same way",
    rows: [{ object: "public.foo(uuid)", kind: "function", acl: "NULL" }],
    allowlist: {},
    expect: 1,
  },
  {
    name: "a NULL acl on a table is not this check's business",
    rows: [{ object: "public.things", kind: "table", acl: null }],
    allowlist: {},
    expect: 0,
  },
  {
    name: "a grant option marker does not hide the privilege",
    rows: [{ object: "public.foo(uuid)", acl: "{=X*/postgres}" }],
    allowlist: {},
    expect: 1,
  },
  {
    name: "a quoted acl item is parsed, not skipped",
    rows: [{ object: "public.foo(uuid)", acl: '{"anon=X/postgres"}' }],
    allowlist: {},
    expect: 1,
  },
  {
    name: "a role whose name merely starts with anon is not anon",
    rows: [{ object: "public.foo(uuid)", acl: "{anonymiser=X/postgres}" }],
    allowlist: {},
    expect: 0,
  },
  {
    name: "PUBLIC SELECT on a table relacl is reported too",
    rows: [{ object: "public.things", kind: "table", acl: "{=r/postgres,postgres=arwdDxt/postgres}" }],
    allowlist: {},
    expect: 1,
  },
  {
    name: "an allowlisted object passes",
    rows: [{ object: "public.foo(uuid)", acl: "{=X/postgres}" }],
    allowlist: { "public.foo(uuid)": "reason" },
    expect: 0,
  },
  {
    name: "the text shape parses, empty grantee included",
    rows: parseSnapshot("public.foo(uuid)  {=X/postgres}\npublic.bar(uuid)  {postgres=X/postgres}"),
    allowlist: {},
    expect: 1,
  },
  {
    name: "a text line with no acl column is a NULL acl",
    rows: parseSnapshot("public.foo(uuid)  NULL"),
    allowlist: {},
    expect: 1,
  },
];

function selftest() {
  let failed = 0;
  for (const c of CASES) {
    const got = checkSnapshot(c.rows, c.allowlist).length;
    if (got !== c.expect) {
      failed += 1;
      console.error(`  FAIL ${c.name}: expected ${c.expect} finding(s), got ${got}`);
    }
  }
  if (failed) {
    console.error(`anon-acl self-test FAILED: ${failed} of ${CASES.length} case(s).`);
    process.exit(1);
  }
  console.log(`anon-acl self-test OK: ${CASES.length} parser cases pass.`);
}

/* ----------------------------------------------------------------------- main ------ */

const args = process.argv.slice(2);

if (args.includes("--selftest")) {
  selftest();
} else {
  const file = args.find((a) => !a.startsWith("-"));
  if (!file) {
    console.log(
      "usage: node scripts/check-anon-acl-snapshot.mjs <snapshot-file>\n" +
      "       node scripts/check-anon-acl-snapshot.mjs --selftest\n" +
      "No snapshot given, nothing checked. This reads a catalog snapshot, it does not " +
      "connect to a database.");
    process.exit(0);
  }
  if (!existsSync(file)) {
    console.error(`MISSING: ${file}`);
    process.exit(1);
  }
  const allowlist = existsSync(ALLOWLIST)
    ? (JSON.parse(readFileSync(ALLOWLIST, "utf8")).functions ?? {})
    : {};
  const rows = parseSnapshot(readFileSync(file, "utf8"));
  const fail = checkSnapshot(rows, allowlist);
  if (fail.length) {
    console.error(`live ACL snapshot check FAILED, ${fail.length} finding(s):\n`);
    for (const f of fail) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`live ACL snapshot check OK: ${rows.length} object(s), no unauthenticated reach.`);
}
