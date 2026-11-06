#!/usr/bin/env node
/**
 * ONE serializer for the anon ACL snapshot. The emitter side and the gate side both
 * import this module. Neither is allowed a private copy: a digest is only meaningful
 * while exactly one piece of code decides what string gets hashed.
 *
 * THE RULE SET, verbatim, because the header is what the next reader trusts.
 *
 *   Row form      `kind|object|acl`, a single pipe, no spaces around it.
 *                 `object` is the regprocedure text for a function and `schema.name`
 *                 for a view or a matview. `kind` is explicit on every row and is
 *                 never defaulted here.
 *
 *   Sort key      `kind|object` ONLY, never the full serialized line. The identity is
 *                 already unique (a regprocedure is unique, and `schema.name` is
 *                 unique per kind), so this is a total order with no ties. Sorting on
 *                 the identity means a pure grant change lands as a ONE LINE in place
 *                 diff rather than a reshuffle of the whole file. Codepoint order,
 *                 which is what `collate "C"` gives for everything we emit. Not
 *                 localeCompare: that would make the digest depend on the machine.
 *
 *   Join          "\n" between lines, and NO trailing newline.
 *
 *   NULL acl      the four literal characters `null`.
 *
 *   Empty acl     `{}`. A NULL acl and an empty acl MUST NEVER COLLAPSE to the same
 *                 token. NULL means no GRANT and no REVOKE has ever run, so the built
 *                 in default stands, and for a function that default is EXECUTE to
 *                 PUBLIC. Empty means the object HAS an ACL and it grants nobody
 *                 anything. NULL is the MOST OPEN state, not "no grants", and empty is
 *                 the clean one. Normalizing either into the other is how wide access
 *                 walks straight past this belt.
 *
 *   Acl entries   sorted by codepoint before joining, and otherwise VERBATIM. An entry
 *                 with an EMPTY GRANTEE stays exactly as it is, because the empty
 *                 grantee is how Postgres writes the PUBLIC pseudo role: `=X/postgres`
 *                 is PUBLIC holding EXECUTE. The sort is not cosmetic. Postgres gives
 *                 no ordering guarantee on an aclitem array, and reordered acls have
 *                 been read off a live database with nothing else changed. Without the
 *                 sort the gate reds a clean file.
 *
 *   regprocedure  must be generated with a PINNED search_path so it always renders
 *                 schema qualified. The same function renders `foo(uuid)` in a session
 *                 whose search_path covers its schema and `public.foo(uuid)` in one
 *                 that does not, and the digest would flip with nothing changed. That
 *                 pin belongs to the emitting query, and it is written down here so
 *                 the two halves cannot disagree about it.
 *
 * WHY `kind` IS NOT DEFAULTED. The finding checker defaults a missing `kind` to
 * "function", which is the safe reading there: it decides whether a NULL acl is an
 * open function or an uninteresting table. Here `kind` is part of the SORT KEY, so a
 * silently defaulted kind moves a row and changes the digest with no visible cause.
 * A row without a kind throws.
 *
 * Run `node scripts/lib/snapshot-serialize.mjs --selftest` to exercise all of it.
 */

import { createHash } from "node:crypto";

/** Codepoint comparison. Deliberately not localeCompare, see the header. */
export const byCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Split an acl into its entries, keeping each entry's text VERBATIM, quotes included.
 * Returns null for a NULL acl and [] for an empty one. Those two are different answers
 * and the caller must keep them different.
 *
 * A quoted entry may contain a comma, so this is a scan and not a split on ",". The
 * quotes are kept rather than stripped: we only ever JOIN these entries, never split
 * them again, and dropping the quoting would let two different acls serialize to the
 * same line.
 */
export function aclEntries(raw) {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  const text = String(raw).trim();
  if (text === "" || text.toUpperCase() === "NULL") return null;
  const inner = text.replace(/^\{/, "").replace(/\}$/, "");
  if (inner.trim() === "") return [];
  const out = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "\\") { i += 1; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === "," && !quoted) { out.push(inner.slice(start, i)); start = i + 1; }
  }
  out.push(inner.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * The acl field of one serialized row: `null`, or `{}`, or the entries sorted and
 * joined. Accepts the emitted JSON array shape and the array literal string shape,
 * because the emitter has used both and the gate must read either one identically.
 */
export function canonicalAcl(raw) {
  const entries = aclEntries(raw);
  if (entries === null) return "null";
  return `{${entries.slice().sort(byCodepoint).join(",")}}`;
}

/**
 * The sort key and the first two fields of a row: `kind|object`. Throws rather than
 * guessing, because every guess here silently moves a line and changes the digest.
 */
export function rowIdentity(row) {
  const kind = String(row?.kind ?? "").trim().toLowerCase();
  const object = String(row?.identity ?? row?.object ?? "").trim();
  if (!kind) {
    throw new Error(
      `snapshot row for "${object || "an unnamed object"}" carries no \`kind\`. Kind is ` +
      `part of the sort key, so defaulting it would move the row and change the digest ` +
      `with nothing to show for it. Fix the emitting query.`);
  }
  if (!object) {
    throw new Error(
      `a snapshot row of kind "${kind}" carries no \`identity\` and no \`object\`, so it ` +
      `cannot be named, sorted or allowlisted. The snapshot is malformed.`);
  }
  return `${kind}|${object}`;
}

/** One row as its serialized line. */
export function serializeRow(row) {
  return `${rowIdentity(row)}|${canonicalAcl(row?.acl)}`;
}

/**
 * The whole snapshot as the exact string the digest is taken over. Sorted by identity,
 * joined with "\n", no trailing newline.
 *
 * An empty rows list THROWS. A snapshot that captured nothing is not a clean database,
 * it is a broken emit, and a broken emit is otherwise the greenest possible result.
 * A duplicate identity throws too: two rows claiming the same object make the file
 * ambiguous about which acl is live, and sorting would hide it.
 */
export function serializeRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(
      "snapshot carries no rows. An empty snapshot is not a clean result, it is an " +
      "emit that failed to capture. Refusing to produce a digest over nothing.");
  }
  const seen = new Set();
  const keyed = rows.map((row) => {
    const key = rowIdentity(row);
    if (seen.has(key)) {
      throw new Error(
        `snapshot carries two rows for \`${key}\`. Which acl is live is then a coin ` +
        `flip, and sorting would bury it. Fix the emitting query.`);
    }
    seen.add(key);
    return { key, line: serializeRow(row) };
  });
  keyed.sort((a, b) => byCodepoint(a.key, b.key));
  return keyed.map((entry) => entry.line).join("\n");
}

/** The pinned value: sha256 over serializeRows, lowercase hex, full length. */
export function snapshotDigest(rows) {
  return createHash("sha256").update(serializeRows(rows), "utf8").digest("hex");
}

/* ------------------------------------------------------------------ self-test ------ */

const NULL_ROW = { kind: "function", object: "public.set_updated_at()", acl: null };
const EMPTY_ROW = { kind: "function", object: "public.set_updated_at()", acl: [] };

/** An acl entry carrying both of the characters we join on. We never split a line back
 *  apart, so this has to be provably harmless rather than merely unlikely. */
const PIPE_COMMA = '"weird|role=X/pipe,grantor"';

const CASES = [
  {
    name: "a NULL acl is the four literal characters",
    run: () => serializeRow(NULL_ROW),
    expect: "function|public.set_updated_at()|null",
  },
  {
    name: "an empty acl is {} and does NOT collapse into null",
    run: () => serializeRow(EMPTY_ROW),
    expect: "function|public.set_updated_at()|{}",
  },
  {
    name: "null and empty serialize to different lines",
    run: () => serializeRow(NULL_ROW) !== serializeRow(EMPTY_ROW),
    expect: true,
  },
  {
    name: "the literal string NULL is read as a NULL acl",
    run: () => canonicalAcl("NULL"),
    expect: "null",
  },
  {
    name: "an empty grantee stays verbatim, it is the PUBLIC role",
    run: () => canonicalAcl("{=X/postgres}"),
    expect: "{=X/postgres}",
  },
  {
    name: "acl entries are sorted, so a reordered acl is not drift",
    run: () =>
      canonicalAcl(["service_role=X/postgres", "anon=X/postgres", "postgres=X/postgres"]) ===
      canonicalAcl(["postgres=X/postgres", "anon=X/postgres", "service_role=X/postgres"]),
    expect: true,
  },
  {
    name: "an acl entry containing a pipe and a comma survives verbatim",
    run: () => canonicalAcl(`{${PIPE_COMMA},anon=X/postgres}`),
    expect: `{${PIPE_COMMA},anon=X/postgres}`,
  },
  {
    name: "that entry is still one entry, not two",
    run: () => aclEntries(`{${PIPE_COMMA},anon=X/postgres}`).length,
    expect: 2,
  },
  {
    name: "overloaded functions are two distinct rows, so this is regprocedure not proname",
    run: () => serializeRows([
      { kind: "function", object: "public.foo(text)", acl: [] },
      { kind: "function", object: "public.foo(uuid)", acl: [] },
    ]),
    expect: "function|public.foo(text)|{}\nfunction|public.foo(uuid)|{}",
  },
  {
    name: "input row order does not reach the output",
    run: () =>
      serializeRows([
        { kind: "view", object: "public.b", acl: [] },
        { kind: "function", object: "public.a()", acl: [] },
      ]) ===
      serializeRows([
        { kind: "function", object: "public.a()", acl: [] },
        { kind: "view", object: "public.b", acl: [] },
      ]),
    expect: true,
  },
  {
    name: "a grant change is a one line in place diff, not a reshuffle",
    run: () => {
      const before = serializeRows([
        { kind: "function", object: "public.a()", acl: ["postgres=X/postgres"] },
        { kind: "function", object: "public.b()", acl: ["postgres=X/postgres"] },
        { kind: "function", object: "public.c()", acl: ["postgres=X/postgres"] },
      ]).split("\n");
      const after = serializeRows([
        { kind: "function", object: "public.a()", acl: ["postgres=X/postgres"] },
        { kind: "function", object: "public.b()", acl: ["postgres=X/postgres", "anon=X/postgres"] },
        { kind: "function", object: "public.c()", acl: ["postgres=X/postgres"] },
      ]).split("\n");
      return before.filter((line, i) => line !== after[i]).length;
    },
    expect: 1,
  },
  {
    name: "no trailing newline",
    run: () => serializeRows([NULL_ROW]).endsWith("\n"),
    expect: false,
  },
  {
    name: "the digest is stable across a permuted input",
    run: () =>
      snapshotDigest([
        { kind: "matview", object: "public.z", acl: null },
        { kind: "function", object: "public.a()", acl: ["anon=X/postgres"] },
      ]) ===
      snapshotDigest([
        { kind: "function", object: "public.a()", acl: ["anon=X/postgres"] },
        { kind: "matview", object: "public.z", acl: null },
      ]),
    expect: true,
  },
  {
    name: "the digest moves when only an acl moves",
    run: () =>
      snapshotDigest([{ kind: "function", object: "public.a()", acl: [] }]) !==
      snapshotDigest([{ kind: "function", object: "public.a()", acl: null }]),
    expect: true,
  },
];

const THROW_CASES = [
  { name: "an empty rows list throws", run: () => serializeRows([]) },
  { name: "a non array rows throws", run: () => serializeRows(null) },
  { name: "a missing kind throws", run: () => serializeRow({ object: "public.a()", acl: [] }) },
  { name: "a missing object throws", run: () => serializeRow({ kind: "function", acl: [] }) },
  {
    name: "a duplicate identity throws",
    run: () => serializeRows([
      { kind: "function", object: "public.a()", acl: [] },
      { kind: "function", object: "public.a()", acl: ["anon=X/postgres"] },
    ]),
  },
];

function selftest() {
  let failed = 0;
  for (const c of CASES) {
    let got;
    try { got = c.run(); } catch (err) { got = `threw: ${err.message}`; }
    if (got !== c.expect) {
      failed += 1;
      console.error(`  FAIL ${c.name}\n    expected ${JSON.stringify(c.expect)}\n    got      ${JSON.stringify(got)}`);
    }
  }
  for (const c of THROW_CASES) {
    let threw = false;
    try { c.run(); } catch { threw = true; }
    if (!threw) {
      failed += 1;
      console.error(`  FAIL ${c.name}: returned instead of throwing.`);
    }
  }
  const total = CASES.length + THROW_CASES.length;
  if (failed) {
    console.error(`snapshot-serialize self-test FAILED: ${failed} of ${total} case(s).`);
    process.exit(1);
  }
  console.log(`snapshot-serialize self-test OK: ${total} cases pass.`);
}

if (process.argv.slice(2).includes("--selftest")) selftest();
