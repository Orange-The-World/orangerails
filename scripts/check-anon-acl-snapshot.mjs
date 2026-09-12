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
 * reads a snapshot file refreshed by the database steward. Three shapes are accepted:
 *
 *   emitted JSON
 *     { "snapshot_objects": { "ref_sha256": "<digest>",
 *                             "rows": [ { "identity": "public.foo(uuid)",
 *                                         "acl": ["=X/postgres"], "keeper": false } ] },
 *       "generated_at": "2026-07-23T00:00:00Z" }
 *
 *   flat JSON   [ { "object": "public.foo(uuid)", "kind": "function", "acl": "{=X/postgres}" } ]
 *   text        public.foo(uuid)  {=X/postgres}          (one object per line)
 *
 * The emitted shape is the one the steward's tool writes: rows live under
 * `snapshot_objects.rows`, each row names its object as `identity`, and `acl` is a
 * JSON array of aclitems rather than an array literal string. `generated_at` sits
 * outside the compared object so freshness never dirties a diff, and no raw project
 * ref is emitted, only `ref_sha256`.
 *
 * A JSON file matching NONE of these is an error, never an empty row list. The
 * emitter refuses to write an empty `rows`, and this side has to refuse to pass on
 * one, or a shape drift on either half turns the gate green while checking nothing.
 *
 * In the text shape the object name is everything before the first `{`, and a line
 * whose ACL column is empty or the word NULL is read as a NULL acl, which for a
 * function is the open case above, not a clean one. The text shape carries no `kind`
 * column, so every row in it is read as a function. A snapshot that includes tables
 * should be emitted in a JSON shape with `kind` set per row, or a table whose acl
 * is NULL is reported as an open function.
 *
 * ALLOWLIST. Same file as the source gate, `supabase/anon-executable-rpcs.json`, but
 * a DIFFERENT KEY. The source gate reads `functions` and holds that list to our SQL:
 * an entry there with no matching GRANT in a migration fails as stale. Almost nothing
 * this check finds was written by a migration, so declaring those objects under
 * `functions` would turn the build red on the source gate rather than quiet this one.
 * They belong under `snapshot_objects`, which only this file reads. Both lists are
 * accepted here, because a function our SQL deliberately grants to anon is expected to
 * show up in the catalog as well and should not have to be declared twice. A stale
 * entry is not an error here: a snapshot is a point in time, and the source gate
 * already owns exactness for its own list.
 *
 * Run `node scripts/check-anon-acl-snapshot.mjs --selftest` to exercise the parser,
 * and `node scripts/check-anon-acl-snapshot.mjs <snapshot-file>` to check a snapshot.
 */

import { readFileSync, existsSync } from "node:fs";

const ALLOWLIST = "supabase/anon-executable-rpcs.json";

/** The key in that file that belongs to this check. Named in every failure message, so
 *  nobody is sent to the source gate's list by our own error text. The snapshot file
 *  happens to use the same word for its top level wrapper. Different files, same
 *  intent, and neither is read from the other. */
const SNAPSHOT_KEY = "snapshot_objects";

/** Grantees that mean "reachable without a signed in user", plus the one that means
 *  "reachable by any signed in user". Both are findings: the first is the anonymous
 *  surface, the second is every account on the platform. PUBLIC is wider than either,
 *  because every role inherits it. */
const RISKY = new Set(["PUBLIC", "anon", "authenticated"]);

/** Privilege letters we care about. X is EXECUTE on a function. r/w/a/d are the table
 *  side, carried because relacl snapshots go through the same parser. */
const PRIV_NAMES = { r: "SELECT", w: "UPDATE", a: "INSERT", d: "DELETE", X: "EXECUTE" };

/**
 * Merge the two lists in the allowlist file into the one set this check honours.
 * `parsed` is the whole parsed JSON. A file missing either key is read without error,
 * because this script also runs against files written before the split.
 */
export function allowlistFrom(parsed) {
  const file = parsed ?? {};
  return { ...(file.functions ?? {}), ...(file[SNAPSHOT_KEY] ?? {}) };
}

/**
 * Split a Postgres ACL array literal into its items. Items may be quoted, and a quoted
 * item may contain a comma, so this is a scan rather than a split on ",".
 *
 * An `acl` that is already a JSON array is taken item for item. That case matters:
 * an EMPTY array means the object has an ACL and it grants nobody anything, which is
 * clean. A NULL acl means no GRANT or REVOKE ever ran, which leaves the built in
 * default in place, and for a function that default is EXECUTE to PUBLIC. Collapsing
 * the two would report the safest possible row as the most open one.
 */
export function aclItems(raw) {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
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
 * A row names its object as `identity` (emitted shape) or `object` (flat shape),
 * carries an `acl`, and may carry a `kind`, which defaults to "function".
 */
export function checkRow(row, allowed) {
  const object = String(row.identity ?? row.object ?? "").trim();
  const kind = (row.kind ?? "function").toLowerCase();
  const findings = [];

  if (!object) {
    // Without a name there is nothing to look up, and the allowlist lookup would key
    // on the empty string, so every unnamed row would pass. Report it instead.
    findings.push(
      "a snapshot row carries no `identity` and no `object`, so it cannot be named " +
      "or allowlisted. The snapshot is malformed, fix the emitter rather than this " +
      "row.");
    return findings;
  }

  const items = aclItems(row.acl);

  if (items === null) {
    // NULL acl means the object still carries the built in default. For a function
    // that default is EXECUTE to PUBLIC, so this is the open case, not a clean one.
    if (kind === "function" && !allowed.has(object)) {
      findings.push(
        `${object}: acl is NULL, so no GRANT or REVOKE has ever touched this function ` +
        `and the built in default stands: PUBLIC holds EXECUTE. Revoke it, or add ` +
        `"${object}" to the ${SNAPSHOT_KEY} list in ${ALLOWLIST} with a one line reason.`);
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
      `"${object}" to the ${SNAPSHOT_KEY} list in ${ALLOWLIST} with a one line reason.`);
  }
  return findings;
}

/** Check a whole snapshot. `rows` is an array of rows as described on checkRow. */
export function checkSnapshot(rows, allowlist) {
  const allowed = new Set(Object.keys(allowlist ?? {}));
  return rows.flatMap((row) => checkRow(row, allowed));
}

/**
 * Read a snapshot file in any accepted shape. Text lines are split at the first `{`,
 * so an object name containing a space or a signature survives intact.
 *
 * A JSON object with no rows array anywhere it is looked for THROWS. Returning an
 * empty list there is the failure mode this whole file exists to prevent: the check
 * would print a clean result having examined nothing.
 */
export function parseSnapshot(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    const rows = parsed?.[SNAPSHOT_KEY]?.rows ?? parsed?.rows;
    if (!Array.isArray(rows)) {
      throw new Error(
        `snapshot JSON carries no rows array. Expected \`${SNAPSHOT_KEY}.rows\` (the ` +
        `emitted shape) or a top level \`rows\`. Refusing to report a clean result ` +
        `on a file this check cannot read.`);
    }
    return rows;
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
  {
    name: "an object declared only under snapshot_objects passes",
    rows: [{ object: "public.foo(uuid)", acl: "{authenticated=X/postgres}" }],
    allowlist: allowlistFrom({ functions: {}, snapshot_objects: { "public.foo(uuid)": "reason" } }),
    expect: 0,
  },
  {
    name: "both lists are honoured, and an object in neither still fails",
    rows: [
      { object: "public.foo(uuid)", acl: "{anon=X/postgres}" },
      { object: "public.bar(uuid)", acl: "{authenticated=X/postgres}" },
      { object: "public.baz(uuid)", acl: "{authenticated=X/postgres}" },
    ],
    allowlist: allowlistFrom({
      functions: { "public.foo(uuid)": "reason" },
      snapshot_objects: { "public.bar(uuid)": "reason" },
    }),
    expect: 1,
  },
  {
    name: "an allowlist file with no snapshot_objects key is read without error",
    rows: [{ object: "public.foo(uuid)", acl: "{anon=X/postgres}" }],
    allowlist: allowlistFrom({ functions: { "public.foo(uuid)": "reason" } }),
    expect: 0,
  },
  {
    name: "the emitted shape is read, rows and all",
    rows: parseSnapshot(JSON.stringify({
      snapshot_objects: {
        ref_sha256: "0".repeat(64),
        rows: [
          { identity: "public.foo(uuid)", acl: ["=X/postgres"], keeper: false },
          { identity: "public.bar(uuid)", acl: ["postgres=X/postgres"], keeper: false },
        ],
      },
      generated_at: "2026-07-23T00:00:00Z",
    })),
    allowlist: {},
    expect: 1,
  },
  {
    name: "a keeper row is compared like any other, not skipped",
    rows: parseSnapshot(JSON.stringify({
      snapshot_objects: {
        ref_sha256: "0".repeat(64),
        rows: [{ identity: "public.is_staff()", acl: ["anon=X/postgres"], keeper: true }],
      },
      generated_at: "2026-07-23T00:00:00Z",
    })),
    allowlist: {},
    expect: 1,
  },
  {
    name: "an acl JSON array is parsed item for item",
    rows: [{ identity: "public.foo(uuid)", acl: ["postgres=X/postgres", "anon=X/postgres"] }],
    allowlist: {},
    expect: 1,
  },
  {
    name: "an EMPTY acl array grants nobody anything and is clean",
    rows: [{ identity: "public.foo(uuid)", kind: "function", acl: [] }],
    allowlist: {},
    expect: 0,
  },
  {
    name: "a row with no identity and no object is a finding, not a skip",
    rows: [{ acl: ["=X/postgres"] }],
    allowlist: {},
    expect: 1,
  },
];

/** Cases that must THROW out of parseSnapshot rather than yield an empty list. */
const THROW_CASES = [
  {
    name: "a JSON object with no rows anywhere throws",
    text: JSON.stringify({ generated_at: "2026-07-23T00:00:00Z" }),
  },
  {
    name: "the wrapper present but rows missing throws",
    text: JSON.stringify({ snapshot_objects: { ref_sha256: "0".repeat(64) } }),
  },
  {
    name: "rows present but not an array throws",
    text: JSON.stringify({ snapshot_objects: { rows: "none" } }),
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
  for (const c of THROW_CASES) {
    let threw = false;
    try { parseSnapshot(c.text); } catch { threw = true; }
    if (!threw) {
      failed += 1;
      console.error(`  FAIL ${c.name}: parseSnapshot returned instead of throwing.`);
    }
  }
  const total = CASES.length + THROW_CASES.length;
  if (failed) {
    console.error(`anon-acl self-test FAILED: ${failed} of ${total} case(s).`);
    process.exit(1);
  }
  console.log(`anon-acl self-test OK: ${total} parser cases pass.`);
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
    ? allowlistFrom(JSON.parse(readFileSync(ALLOWLIST, "utf8")))
    : {};

  let rows;
  try {
    rows = parseSnapshot(readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`UNREADABLE: ${file}\n  ${err.message}`);
    process.exit(1);
  }

  // The emitter aborts rather than write an empty rows list. This side has to refuse
  // to pass on one, or a truncated or filtered snapshot reads as a clean database.
  if (rows.length === 0) {
    console.error(
      `EMPTY: ${file} carries no objects. A snapshot with nothing in it is not a ` +
      `clean result, it is a snapshot that failed to capture. Re-run the emitter.`);
    process.exit(1);
  }

  const fail = checkSnapshot(rows, allowlist);
  if (fail.length) {
    console.error(`live ACL snapshot check FAILED, ${fail.length} finding(s):\n`);
    for (const f of fail) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`live ACL snapshot check OK: ${rows.length} object(s), no unauthenticated reach.`);
}
