#!/usr/bin/env node
/**
 * Provenance gate for a live catalog ACL snapshot. Companion to
 * `check-anon-acl-snapshot.mjs`, which reads the ROWS of a snapshot and reports
 * unauthenticated reach. This file reads the HEADER, and answers the two questions
 * the rows cannot answer about themselves:
 *
 *   is this snapshot recent enough for a pass to mean anything
 *   was it taken against the database this slot is supposed to describe
 *
 * A snapshot is a photograph. A stale one is a photograph of a database that has
 * moved on, and a green build against it is worse than no build at all, because a
 * green build reads as evidence. A dev snapshot dropped into the prod slot is worse
 * again: it passes every row check ever written, because every row in it is true,
 * just true about the wrong database. Both read as success without this file.
 *
 * WHY A DIGEST AND NOT THE PROJECT REF. A project ref is a database identifier and
 * this repository is public, so a ref never lands here: not in a snapshot file, not
 * in a constant below, not in an error message. What lands is a truncated sha256 of
 * it. The digest is still derived from the live connection the snapshot was taken
 * through, so it fails in exactly the cases the raw ref would, and on its own it
 * identifies nothing and reaches nothing. A snapshot carrying a raw `ref` key is
 * refused rather than tolerated, because a tolerated one eventually gets committed.
 *
 * THE RECIPE IS PINNED. Both ends must use the same one, or this fails a snapshot
 * that is perfectly good and sends someone hunting a database problem that does not
 * exist:
 *
 *   sha256 over the RAW REF STRING ONLY, lowercase, NO TRAILING NEWLINE,
 *   hex encoded, first 16 characters.
 *
 * In node that is exactly:
 *
 *   crypto.createHash("sha256").update(ref).digest("hex").slice(0, 16)
 *
 * A shell `echo` appends a newline and hashes 21 bytes instead of 20, which produces
 * a completely different digest for a reason that has nothing to do with the
 * database. Regenerate with `printf`, or with the emitter's own SQL, never `echo`.
 *
 * Sixty four bits is short for a digest and deliberately so. This is an equality
 * check between two known values, not a signature: there is no attacker to collide
 * against, and a short constant is one a human can compare at a glance.
 *
 * usage: node scripts/check-snapshot-header.mjs <snapshot-file> --env dev|prod
 *        node scripts/check-snapshot-header.mjs --selftest
 */

import { readFileSync, existsSync } from "node:fs";

/** How old a snapshot may be before a pass stops meaning anything. Fourteen days,
 *  not seven: a tighter window fails builds on quiet weeks when nothing about the
 *  ACL surface moved, and a gate that cries wolf is a gate that gets switched off. */
export const MAX_AGE_DAYS = 14;

/** Truncated sha256 of each project ref, per the recipe pinned in the header above.
 *  These are digests, not identifiers. Regenerating one requires the ref, which
 *  lives with the database steward and not in this repository. */
export const EXPECTED_REF_SHA256 = {
  dev: "d2a4f2f3044ce978",
  prod: "13a0611305e7ad56",
};

/** A snapshot stamped slightly in the future is a clock difference between the
 *  emitter and the runner, not a forgery. Past this, it is a wrong timestamp. */
const CLOCK_SKEW_MINUTES = 60;

const DIGEST_SHAPE = /^[0-9a-f]{16}$/;

/** An ISO 8601 instant must carry its zone. A bare "2026-07-23T10:00:00" is read as
 *  LOCAL time, so the same file would be a different age on a differently configured
 *  runner. Require Z or an explicit offset rather than trusting the runner is UTC. */
const ISO_WITH_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Check the header of one parsed snapshot. Returns an array of finding strings, empty
 * when the header is good. `nowMs` is injected so the age rule is testable and so a
 * run is reproducible.
 */
export function checkHeader(parsed, env, nowMs) {
  const findings = [];

  if (!EXPECTED_REF_SHA256[env]) {
    return [`unknown slot "${env}": expected one of ${Object.keys(EXPECTED_REF_SHA256).join(", ")}.`];
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [
      "snapshot has no header. A bare array of rows carries no age and no database " +
      "identity, so a pass against it proves nothing. Emit an object with " +
      "generated_at, ref_sha256 and rows.",
    ];
  }

  // Refused, not merely unused. This repository is public and a project ref is a
  // database identifier, so the key must not exist rather than be ignored.
  if ("ref" in parsed) {
    findings.push(
      "snapshot carries a raw `ref` key. A project ref is a database identifier and " +
      "this repository is public, so it must not be committed. Emit `ref_sha256` " +
      "only, and remove the `ref` key rather than leaving it alongside.");
  }

  const digest = parsed.ref_sha256;
  if (typeof digest !== "string" || !DIGEST_SHAPE.test(digest)) {
    findings.push(
      `ref_sha256 is missing or malformed (expected 16 lowercase hex characters, got ` +
      `${JSON.stringify(digest)}). Without it there is nothing tying this file to the ` +
      `database it claims to describe.`);
  } else if (digest !== EXPECTED_REF_SHA256[env]) {
    const other = Object.keys(EXPECTED_REF_SHA256).find((k) => EXPECTED_REF_SHA256[k] === digest);
    findings.push(other
      ? `ref_sha256 in the ${env} slot is the digest recorded for the ${other} database. ` +
        `The two snapshot files are swapped, or one was regenerated against the wrong ` +
        `connection. Every row in it can be true and still describe the wrong database.`
      : `ref_sha256 does not match the digest recorded for the ${env} database, and does ` +
        `not match any other slot either. Either this was taken against an unexpected ` +
        `connection, or the digest was computed with a different recipe: it is sha256 of ` +
        `the raw ref with NO trailing newline, hex, first 16 characters. A shell echo ` +
        `appends a newline and gives a different answer.`);
  }

  const stamp = parsed.generated_at;
  if (typeof stamp !== "string" || !ISO_WITH_ZONE.test(stamp.trim())) {
    findings.push(
      `generated_at is missing or carries no timezone (got ${JSON.stringify(stamp)}). ` +
      `An instant without a zone is read as local time, so the same file would be a ` +
      `different age on a differently configured runner. Emit ISO 8601 UTC, ending Z.`);
  } else {
    const at = Date.parse(stamp.trim());
    if (Number.isNaN(at)) {
      findings.push(`generated_at is not a parseable instant (got ${JSON.stringify(stamp)}).`);
    } else if (at > nowMs + CLOCK_SKEW_MINUTES * 60_000) {
      findings.push(
        `generated_at is in the future (${stamp}). That is a wrong timestamp, not a ` +
        `fresh snapshot, and it would keep this file passing the age rule forever.`);
    } else {
      const ageDays = (nowMs - at) / 86_400_000;
      if (ageDays > MAX_AGE_DAYS) {
        findings.push(
          `snapshot is ${ageDays.toFixed(1)} days old, older than the ${MAX_AGE_DAYS} day ` +
          `limit. It describes a database as it was, not as it is, so a pass against it is ` +
          `not evidence. The database steward regenerates it.`);
      }
    }
  }

  if (!Array.isArray(parsed.rows)) {
    findings.push(`rows is missing or not an array (got ${typeof parsed.rows}).`);
  } else if (parsed.rows.length === 0) {
    findings.push(
      "rows is empty. An emit that returned nothing is a broken query, not a clean " +
      "database, and it is the greenest possible result for every row check that reads it.");
  }

  return findings;
}

/* ------------------------------------------------------------------ self-test ------ */

const NOW = Date.parse("2026-07-23T12:00:00Z");

const good = () => ({
  generated_at: "2026-07-23T09:00:00Z",
  ref_sha256: EXPECTED_REF_SHA256.dev,
  rows: [{ object: "public.foo(uuid)", kind: "function", acl: "{postgres=X/postgres}" }],
});

const CASES = [
  { name: "a fresh, correctly stamped dev snapshot passes", header: good(), env: "dev", expect: 0 },
  {
    name: "the dev file in the prod slot fails",
    header: good(), env: "prod", expect: 1,
  },
  {
    name: "a raw ref key fails even when everything else is right",
    header: { ...good(), ref: "some-project-ref" }, env: "dev", expect: 1,
  },
  {
    name: "a missing ref_sha256 fails",
    header: (() => { const h = good(); delete h.ref_sha256; return h; })(), env: "dev", expect: 1,
  },
  {
    name: "an uppercase or wrong length digest is malformed, not merely unequal",
    header: { ...good(), ref_sha256: "D2A4F2F3044CE978" }, env: "dev", expect: 1,
  },
  {
    name: "an unrecognised digest fails without naming another slot",
    header: { ...good(), ref_sha256: "0000000000000000" }, env: "dev", expect: 1,
  },
  {
    name: "a snapshot older than the limit fails",
    header: { ...good(), generated_at: "2026-07-01T09:00:00Z" }, env: "dev", expect: 1,
  },
  {
    name: "a snapshot inside the limit passes",
    header: { ...good(), generated_at: "2026-07-10T09:00:00Z" }, env: "dev", expect: 0,
  },
  {
    name: "a timestamp with no zone fails rather than being read as local time",
    header: { ...good(), generated_at: "2026-07-23T09:00:00" }, env: "dev", expect: 1,
  },
  {
    name: "an explicit offset is accepted",
    header: { ...good(), generated_at: "2026-07-23T09:00:00+02:00" }, env: "dev", expect: 0,
  },
  {
    name: "a stamp far in the future fails",
    header: { ...good(), generated_at: "2027-01-01T00:00:00Z" }, env: "dev", expect: 1,
  },
  {
    name: "a stamp inside the clock skew allowance passes",
    header: { ...good(), generated_at: "2026-07-23T12:30:00Z" }, env: "dev", expect: 0,
  },
  {
    name: "an empty rows array fails",
    header: { ...good(), rows: [] }, env: "dev", expect: 1,
  },
  {
    name: "a bare array of rows has no header and fails",
    header: [{ object: "public.foo(uuid)" }], env: "dev", expect: 1,
  },
  {
    name: "an unknown slot fails before anything else is judged",
    header: good(), env: "staging", expect: 1,
  },
];

function selftest() {
  let failed = 0;
  for (const c of CASES) {
    const got = checkHeader(c.header, c.env, NOW).length;
    if (got !== c.expect) {
      failed += 1;
      console.error(`  FAIL ${c.name}: expected ${c.expect} finding(s), got ${got}`);
    }
  }
  if (failed) {
    console.error(`snapshot-header self-test FAILED: ${failed} of ${CASES.length} case(s).`);
    process.exit(1);
  }
  console.log(`snapshot-header self-test OK: ${CASES.length} cases pass.`);
}

/* ----------------------------------------------------------------------- main ------ */

const args = process.argv.slice(2);

if (args.includes("--selftest")) {
  selftest();
} else {
  const envFlag = args.indexOf("--env");
  const env = envFlag === -1 ? null : args[envFlag + 1];
  const file = args.find((a, i) => !a.startsWith("-") && i !== envFlag + 1);
  if (!file || !env) {
    console.error(
      "usage: node scripts/check-snapshot-header.mjs <snapshot-file> --env dev|prod\n" +
      "       node scripts/check-snapshot-header.mjs --selftest\n" +
      "The slot is explicit on purpose: inferring it from the filename would let a\n" +
      "rename quietly disable the check that the file came from the right database.");
    process.exit(1);
  }
  if (!existsSync(file)) {
    console.error(`MISSING: ${file}`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`${file} is not parseable JSON: ${err.message}`);
    process.exit(1);
  }
  const fail = checkHeader(parsed, env, Date.now());
  if (fail.length) {
    console.error(`snapshot header check FAILED for ${file} (${env} slot), ${fail.length} finding(s):\n`);
    for (const f of fail) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`snapshot header check OK: ${file} is a current ${env} snapshot.`);
}
