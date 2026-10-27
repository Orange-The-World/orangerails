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
 * AN ENTRY IS SCOPED TO ITS GRANTEES, and this is the part that is easy to get wrong.
 *
 *     "public.foo(uuid)": { "grantees": ["anon"], "reason": "one line, plain English" }
 *
 * That line excuses an anon grant on that object and NOTHING else. A PUBLIC grant or
 * an authenticated grant on the same object still fails, including one that appears
 * on the database later and that nobody decided. Matching on the object name alone
 * would turn one deliberate decision into a standing exemption for every grantee, and
 * the widening would be invisible: the gate simply stops speaking. A silent gate is
 * worse than no gate, because the build stays green and everyone reads that as an
 * answer.
 *
 * A bare reason string is therefore a HARD PARSE ERROR, not a permissive default. The
 * lenient reading, "no grantees named means every grantee", is exactly the bug above.
 * A grantee spelled as anything other than PUBLIC, anon or authenticated is refused
 * too: those are the only names this check ever reports, so any other spelling is a
 * typo that would allowlist nothing while looking like it allowlisted something.
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

/** Both lists in the allowlist file are read here, in this order. */
const ALLOWLIST_KEYS = ["functions", SNAPSHOT_KEY];

/** Grantees that mean "reachable without a signed in user", plus the one that means
 *  "reachable by any signed in user". Both are findings: the first is the anonymous
 *  surface, the second is every account on the platform. PUBLIC is wider than either,
 *  because every role inherits it. */
const RISKY = new Set(["PUBLIC", "anon", "authenticated"]);

/** Privilege letters we care about. X is EXECUTE on a function. r/w/a/d are the table
 *  side, carried because relacl snapshots go through the same parser. */
const PRIV_NAMES = { r: "SELECT", w: "UPDATE", a: "INSERT", d: "DELETE", X: "EXECUTE" };

/** The shape one allowlist entry has to be written in, quoted back in every error. */
const ENTRY_SHAPE = '{ "grantees": ["anon"], "reason": "one line, plain English" }';

/** Read the grantees one allowlist entry declares. Throws on anything that does not
 *  name them, because the alternative is to invent a default, and every default here
 *  is either "all grantees", which is the silent widening this scoping exists to end,
 *  or "no grantees", which turns a written decision into a line that does nothing. */
function granteesOf(listKey, object, entry) {
  const where = `${ALLOWLIST}: the \`${listKey}\` entry for "${object}"`;
  const fix = `Write it as "${object}": ${ENTRY_SHAPE}`;

  if (typeof entry === "string") {
    throw new Error(
      `${where} is a bare reason string, so it names no grantee. An entry is scoped ` +
      `to the grantees it was written for: read as "any grantee" it would also excuse ` +
      `a PUBLIC or authenticated grant nobody decided. ${fix}`);
  }
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${where} is not an object. ${fix}`);
  }

  const grantees = entry.grantees;
  if (!Array.isArray(grantees) || grantees.length === 0) {
    throw new Error(
      `${where} declares no \`grantees\`. Name every grantee this exemption covers, ` +
      `one array, no empty array. ${fix}`);
  }
  for (const grantee of grantees) {
    if (typeof grantee !== "string" || !RISKY.has(grantee)) {
      throw new Error(
        `${where} names the grantee ${JSON.stringify(grantee)}, which this check never ` +
        `reports. Use exactly one of ${[...RISKY].join(", ")}, spelling and case as ` +
        `written here. Any other name allowlists nothing while looking like it did.`);
    }
  }

  if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
    throw new Error(
      `${where} carries no \`reason\`. An exemption from this gate is a security ` +
      `decision, and the next reader needs the one line that says why. ${fix}`);
  }

  return grantees;
}

/**
 * Merge the two lists in the allowlist file into the one lookup this check honours:
 * a Map of object name to the Set of grantees that object is excused for. `parsed` is
 * the whole parsed JSON. A file missing either key is read without error, because this
 * script also runs against files written before the split.
 */
export function allowlistFrom(parsed) {
  const file = parsed ?? {};
  const allowed = new Map();
  for (const listKey of ALLOWLIST_KEYS) {
    const list = file[listKey];
    if (list === null || list === undefined) continue;
    if (typeof list !== "object" || Array.isArray(list)) {
      throw new Error(
        `${ALLOWLIST}: \`${listKey}\` must be an object keyed by object name, each ` +
        `value ${ENTRY_SHAPE}.`);
    }
    for (const [object, entry] of Object.entries(list)) {
      const set = allowed.get(object) ?? new Set();
      for (const grantee of granteesOf(listKey, object, entry)) set.add(grantee);
      allowed.set(object, set);
    }
  }
  return allowed;
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

/** The allowlist line that would excuse this exact object and grantee, quoted back in
 *  the finding so the fix is a paste rather than a guess at the shape. */
const entryFor = (object, grantee) =>
  `"${object}": { "grantees": ["${grantee}"], "reason": "why this reach is intended" }`;

/**
 * Check one snapshot row. Returns an array of finding strings.
 * A row names its object as `identity` (emitted shape) or `object` (flat shape),
 * carries an `acl`, and may carry a `kind`, which defaults to "function".
 *
 * `allowed` is the Map that allowlistFrom returns: object name to the Set of grantees
 * that object is excused for. An object present with one grantee is NOT excused for
 * another one.
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

  const excused = allowed.get(object) ?? null;
  const allows = (grantee) => excused !== null && excused.has(grantee);
  const items = aclItems(row.acl);

  if (items === null) {
    // NULL acl means the object still carries the built in default. For a function
    // that default is EXECUTE to PUBLIC, so this is the open case, not a clean one.
    // The grantee here is PUBLIC, so an entry naming only anon does not cover it.
    if (kind === "function" && !allows("PUBLIC")) {
      findings.push(
        `${object}: acl is NULL, so no GRANT or REVOKE has ever touched this function ` +
        `and the built in default stands: PUBLIC holds EXECUTE. Revoke it, or add ` +
        `${entryFor(object, "PUBLIC")} to the ${SNAPSHOT_KEY} list in ${ALLOWLIST}.`);
    }
    return findings;
  }

  for (const item of items) {
    const parsed = parseAclItem(item);
    if (!parsed) continue;
    if (!RISKY.has(parsed.grantee)) continue;
    if (!parsed.privileges) continue;
    if (allows(parsed.grantee)) continue;
    const who = parsed.grantee === "PUBLIC"
      ? "PUBLIC (the empty grantee, which every role inherits)"
      : parsed.grantee;
    const already = excused === null
      ? ""
      : ` This object is allowlisted for ${[...excused].join(", ")}, and an entry ` +
        `covers only the grantees it names.`;
    findings.push(
      `${object}: ${who} holds ${describe(parsed.privileges)} (acl item \`${item}\`). ` +
      `Revoke it, naming that grantee: a REVOKE FROM anon does not touch a PUBLIC ` +
      `grant and the reverse is equally true. If the access is intended, add ` +
      `${entryFor(object, parsed.grantee)} to the ${SNAPSHOT_KEY} list in ` +
      `${ALLOWLIST}.${already}`);
  }
  return findings;
}

/**
 * Check a whole snapshot. `rows` is an array of rows as described on checkRow.
 * `allowlist` is either the Map allowlistFrom returns or the parsed allowlist file,
 * which is then read through allowlistFrom and so is held to the same strictness.
 */
export function checkSnapshot(rows, allowlist) {
  const allowed = allowlist instanceof Map ? allowlist : allowlistFrom(allowlist);
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

/** An allowlist entry in the shape this check requires, written out once. */
const entry = (grantees) => ({ grantees, reason: "self-test" });

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
    name: "an object allowlisted for PUBLIC passes on a PUBLIC grant",
    rows: [{ object: "public.foo(uuid)", acl: "{=X/postgres}" }],
    allowlist: { snapshot_objects: { "public.foo(uuid)": entry(["PUBLIC"]) } },
    expect: 0,
  },

  /* The point of the scoping. An entry excuses the grantees it names and no others. */
  {
    name: "an object allowlisted for anon still fails on a PUBLIC grant",
    rows: [{ object: "public.foo(uuid)", acl: "{=X/postgres}" }],
    allowlist: { snapshot_objects: { "public.foo(uuid)": entry(["anon"]) } },
    expect: 1,
  },
  {
    name: "an object allowlisted for anon still fails on an authenticated grant",
    rows: [{ object: "public.foo(uuid)", acl: "{authenticated=X/postgres}" }],
    allowlist: { snapshot_objects: { "public.foo(uuid)": entry(["anon"]) } },
    expect: 1,
  },
  {
    name: "an object allowlisted for anon passes on the anon grant it names",
    rows: [{ object: "public.foo(uuid)", acl: "{anon=X/postgres}" }],
    allowlist: { snapshot_objects: { "public.foo(uuid)": entry(["anon"]) } },
    expect: 0,
  },
  {
    name: "allowlisting anon leaves the other two grantees on the same object reportable",
    rows: [{ object: "public.foo(uuid)", acl: "{anon=X/postgres,=X/postgres,authenticated=X/postgres}" }],
    allowlist: { snapshot_objects: { "public.foo(uuid)": entry(["anon"]) } },
    expect: 2,
  },
  {
    name: "an entry may name more than one grantee, and then covers both",
    rows: [{ object: "public.foo(uuid)", acl: "{anon=X/postgres,authenticated=X/postgres}" }],
    allowlist: { snapshot_objects: { "public.foo(uuid)": entry(["anon", "authenticated"]) } },
    expect: 0,
  },
  {
    name: "a NULL acl is a PUBLIC grant, so an anon entry does not cover it",
    rows: [{ object: "public.foo(uuid)", kind: "function", acl: null }],
    allowlist: { snapshot_objects: { "public.foo(uuid)": entry(["anon"]) } },
    expect: 1,
  },
  {
    name: "a NULL acl is covered by an entry that names PUBLIC",
    rows: [{ object: "public.foo(uuid)", kind: "function", acl: null }],
    allowlist: { snapshot_objects: { "public.foo(uuid)": entry(["PUBLIC"]) } },
    expect: 0,
  },
  {
    name: "an entry for one object does not reach another object",
    rows: [{ object: "public.bar(uuid)", acl: "{anon=X/postgres}" }],
    allowlist: { snapshot_objects: { "public.foo(uuid)": entry(["anon"]) } },
    expect: 1,
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
    allowlist: allowlistFrom({
      functions: {},
      snapshot_objects: { "public.foo(uuid)": entry(["authenticated"]) },
    }),
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
      functions: { "public.foo(uuid)": entry(["anon"]) },
      snapshot_objects: { "public.bar(uuid)": entry(["authenticated"]) },
    }),
    expect: 1,
  },
  {
    name: "the two lists union their grantees for the same object",
    rows: [{ object: "public.foo(uuid)", acl: "{anon=X/postgres,authenticated=X/postgres}" }],
    allowlist: allowlistFrom({
      functions: { "public.foo(uuid)": entry(["anon"]) },
      snapshot_objects: { "public.foo(uuid)": entry(["authenticated"]) },
    }),
    expect: 0,
  },
  {
    name: "an allowlist file with no snapshot_objects key is read without error",
    rows: [{ object: "public.foo(uuid)", acl: "{anon=X/postgres}" }],
    allowlist: allowlistFrom({ functions: { "public.foo(uuid)": entry(["anon"]) } }),
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

/** Allowlist files that must THROW out of allowlistFrom rather than load. Each one
 *  would otherwise become an exemption nobody wrote on purpose. */
const ALLOWLIST_THROW_CASES = [
  {
    name: "a bare reason string names no grantee and throws",
    file: { snapshot_objects: { "public.foo(uuid)": "reason" } },
  },
  {
    name: "a bare reason string under functions throws the same way",
    file: { functions: { "public.foo(uuid)": "reason" } },
  },
  {
    name: "an entry with no grantees key throws",
    file: { snapshot_objects: { "public.foo(uuid)": { reason: "r" } } },
  },
  {
    name: "an empty grantees array throws",
    file: { snapshot_objects: { "public.foo(uuid)": { grantees: [], reason: "r" } } },
  },
  {
    name: "grantees written as a string rather than an array throws",
    file: { snapshot_objects: { "public.foo(uuid)": { grantees: "anon", reason: "r" } } },
  },
  {
    name: "a grantee this check never reports throws",
    file: { snapshot_objects: { "public.foo(uuid)": { grantees: ["service_role"], reason: "r" } } },
  },
  {
    name: "PUBLIC in the wrong case throws rather than silently matching nothing",
    file: { snapshot_objects: { "public.foo(uuid)": { grantees: ["public"], reason: "r" } } },
  },
  {
    name: "an entry with no reason throws",
    file: { snapshot_objects: { "public.foo(uuid)": { grantees: ["anon"] } } },
  },
  {
    name: "a null entry throws",
    file: { snapshot_objects: { "public.foo(uuid)": null } },
  },
  {
    name: "a list written as an array rather than an object throws",
    file: { snapshot_objects: ["public.foo(uuid)"] },
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
  for (const c of ALLOWLIST_THROW_CASES) {
    let threw = false;
    try { allowlistFrom(c.file); } catch { threw = true; }
    if (!threw) {
      failed += 1;
      console.error(`  FAIL ${c.name}: allowlistFrom returned instead of throwing.`);
    }
  }
  const total = CASES.length + THROW_CASES.length + ALLOWLIST_THROW_CASES.length;
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

  // An allowlist this check cannot read is a hard stop, never an empty allowlist.
  // Falling back to "nothing is excused" would fail the build for the wrong reason
  // and send whoever reads it hunting a grant instead of a typo.
  let allowlist;
  try {
    allowlist = existsSync(ALLOWLIST)
      ? allowlistFrom(JSON.parse(readFileSync(ALLOWLIST, "utf8")))
      : new Map();
  } catch (err) {
    console.error(`UNREADABLE ALLOWLIST: ${ALLOWLIST}\n  ${err.message}`);
    process.exit(1);
  }

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
