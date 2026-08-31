#!/usr/bin/env node
/**
 * CI gate: a migration file that declares "-- Requires: <version>" must find that version's
 * file present in this tree.
 *
 * WHY THIS EXISTS. A migration can depend on a column, table or function created by an
 * earlier migration without ever referencing its name in a way a source scan could find (the
 * dependency lives in plpgsql runtime field resolution, or simply in "this row must already
 * exist"). Version numbers already order the apply correctly on every project ONCE BOTH FILES
 * ARE IN THE TREE, because the apply job walks supabase/migrations in version order. The only
 * way the ordering fails is a tree that contains the dependent file and not the prerequisite --
 * which happens exactly when the two live in separate pull requests and the dependent one
 * merges first. That failure is invisible on a project where the prerequisite reached the
 * database out of band: the dependent migration's own assertions pass, dev shows green, and the
 * promoter has no reason to suspect anything is missing.
 *
 * WHAT THIS PROVES: every version named in a "-- Requires:" header, anywhere under
 * supabase/migrations on this tree, has a matching supabase/migrations/<version>_*.sql file in
 * that same tree.
 *
 * WHAT IT DOES NOT PROVE, and nobody should read it as proving. It is a declaration, not
 * discovery: a real dependency with no "-- Requires:" line is invisible to this check, exactly
 * as it was before. It says nothing about apply ORDER beyond version-sorted (OR-T0419 territory)
 * and nothing about a version recorded in a ledger outside this tree. A richer check that
 * inferred dependencies by parsing SQL for column and table references was considered and
 * refused: it needs a real SQL parser to avoid false positives on comments and strings, it
 * cannot see through plpgsql runtime field resolution (the exact mechanism that made this class
 * of bug silent), and a check that fires wrongly gets disabled.
 *
 * WHERE THE OTHER COPY OF THIS DECISION LIVES. check-migration-versions.mjs enforces version
 * uniqueness on the same trigger and the same tree walk. This is a companion, not a
 * replacement: a file can be the only one on its version AND still declare a requirement that is
 * missing from the tree. extractVersion is imported from that script rather than reimplemented,
 * so the two checks can never disagree about what a version IS.
 *
 * IT CANNOT PASS BY LOOKING AT NOTHING. A missing directory and an enumeration of zero .sql
 * files are both hard failures, for the same reason check-migration-versions.mjs treats them
 * that way: a check that reports OK when it examined nothing is the exact shape of control this
 * repo keeps finding and removing.
 *
 * Run `node scripts/check-migration-requires.mjs --selftest` to exercise the logic itself. CI
 * runs the self test BEFORE the check, so a broken parser or comparison fails as itself rather
 * than as a silent pass over every migration.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extractVersion } from "./check-migration-versions.mjs";

const MIGRATIONS_DIR = "supabase/migrations";

// A comment line of the form "-- Requires: 20260831071500". Leading whitespace before the
// dashes is tolerated; the named version is everything after the colon up to end of line,
// trimmed. One line names one version; a file with two dependencies carries two lines.
const REQUIRES_LINE = /^\s*--\s*Requires:\s*(\S+)\s*$/;

/** Every version named in a "-- Requires:" header line of this file's content, in order. */
export function parseRequires(content) {
  const out = [];
  for (const line of content.split("\n")) {
    const m = line.match(REQUIRES_LINE);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * The whole decision, as a pure function over { name, content } pairs, so the self test
 * exercises the real parser and comparison rather than a paraphrase of them.
 *
 * Returns { errors, checked, requiresSeen }. errors is empty only when the gate passes.
 */
export function verdict(files) {
  const errors = [];

  if (files.length === 0) {
    errors.push(
      "no .sql file was found under " + MIGRATIONS_DIR + ". This check enumerated nothing, so " +
      "it proved nothing. Fix the path or the checkout rather than reading this as a pass.");
    return { errors, checked: 0, requiresSeen: 0 };
  }

  const present = new Set(files.map((f) => extractVersion(f.name)));

  let requiresSeen = 0;
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const required of parseRequires(file.content)) {
      requiresSeen += 1;
      if (!present.has(required)) {
        errors.push(
          file.name + " declares \"-- Requires: " + required + "\" but no file for version " +
          required + " (" + MIGRATIONS_DIR + "/" + required + "_*.sql) is present in this tree. " +
          "Either the prerequisite pull request has not merged yet, or the version named is " +
          "wrong. This pull request cannot merge ahead of the migration it depends on.");
      }
    }
  }

  return { errors, checked: files.length, requiresSeen };
}

/* ------------------------------------------------------------------- self test ------ */

const CASES = [
  {
    name: "an empty enumeration is a failure, never a pass",
    files: [],
    expectErrors: 1,
  },
  {
    name: "a file with no Requires header passes",
    files: [{ name: "20260831120000_a.sql", content: "-- just a migration\nselect 1;\n" }],
    expectErrors: 0,
  },
  {
    name: "a Requires header naming a present version passes",
    files: [
      { name: "20260831071500_prereq.sql", content: "-- prerequisite\n" },
      { name: "20260831120000_dependent.sql", content: "-- Requires: 20260831071500\nselect 1;\n" },
    ],
    expectErrors: 0,
  },
  {
    name: "a Requires header naming an absent version fails",
    files: [
      { name: "20260831120000_dependent.sql", content: "-- Requires: 20260831071500\nselect 1;\n" },
    ],
    expectErrors: 1,
  },
  {
    name: "the failure message names the file and the missing version",
    files: [
      { name: "20260831120000_dependent.sql", content: "-- Requires: 20260831071500\nselect 1;\n" },
    ],
    expectErrors: 1,
    expectMessageIncludes: ["20260831120000_dependent.sql", "20260831071500"],
  },
  {
    name: "two Requires lines in one file are checked independently",
    files: [
      { name: "20260831071500_a.sql", content: "-- a\n" },
      {
        name: "20260831120000_b.sql",
        content: "-- Requires: 20260831071500\n-- Requires: 20260830000000\nselect 1;\n",
      },
    ],
    expectErrors: 1, // only 20260830000000 is missing
  },
  {
    name: "leading whitespace before the dashes is tolerated",
    files: [
      { name: "20260831071500_a.sql", content: "-- a\n" },
      { name: "20260831120000_b.sql", content: "  -- Requires: 20260831071500\nselect 1;\n" },
    ],
    expectErrors: 0,
  },
  {
    name: "a line that merely mentions Requires in prose is not parsed as a header",
    // Deliberate: this is a declaration mechanism, not a text scan. A sentence describing a
    // dependency in prose (which the target migration already carries) must not be read as
    // machine-checkable unless it uses the exact header form.
    files: [
      { name: "20260831120000_a.sql", content: "-- This migration requires the prior one.\nselect 1;\n" },
    ],
    expectErrors: 0,
  },
];

const END_TO_END = [
  {
    name: "a real tree where the required version is missing exits 1 and names both",
    files: { "20260831120000_dependent.sql": "-- Requires: 20260831071500\nselect 1;\n" },
    expectStatus: 1,
    expectOutput: "20260831071500",
  },
  {
    name: "a real tree where the required version is present exits 0",
    files: {
      "20260831071500_prereq.sql": "-- prereq\n",
      "20260831120000_dependent.sql": "-- Requires: 20260831071500\nselect 1;\n",
    },
    expectStatus: 0,
    expectOutput: "migration Requires-header check OK",
  },
  {
    name: "an empty migrations directory exits 1, it does not pass",
    files: {},
    expectStatus: 1,
    expectOutput: "enumerated 0 file(s)",
  },
  {
    name: "no migrations directory at all exits 1, it does not pass",
    files: {},
    createDir: false,
    expectStatus: 1,
    expectOutput: "does not exist",
  },
];

function runInTempTree(fileMap, createDir) {
  const root = mkdtempSync(join(tmpdir(), "migration-requires-gate-"));
  try {
    if (createDir) {
      mkdirSync(join(root, MIGRATIONS_DIR), { recursive: true });
      for (const [name, content] of Object.entries(fileMap)) {
        writeFileSync(join(root, MIGRATIONS_DIR, name), content);
      }
    }
    // The check imports check-migration-versions.mjs by relative path, so the throwaway tree
    // needs a copy of it alongside the script under test.
    mkdirSync(join(root, "scripts"), { recursive: true });
    const thisFile = fileURLToPath(import.meta.url);
    const siblingPath = join(fileURLToPath(new URL(".", import.meta.url)), "check-migration-versions.mjs");
    writeFileSync(join(root, "scripts", "check-migration-requires.mjs"), readFileSync(thisFile, "utf8"));
    writeFileSync(join(root, "scripts", "check-migration-versions.mjs"), readFileSync(siblingPath, "utf8"));

    const run = spawnSync(process.execPath, [join(root, "scripts", "check-migration-requires.mjs")], {
      cwd: root,
      encoding: "utf8",
    });
    if (run.error) throw run.error;
    return { status: run.status, output: (run.stdout ?? "") + (run.stderr ?? "") };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function selftest() {
  let failed = 0;

  for (const testCase of CASES) {
    const { errors } = verdict(testCase.files);
    if (errors.length !== testCase.expectErrors) {
      failed += 1;
      console.error(
        "  FAIL " + testCase.name + ": expected " + testCase.expectErrors +
        " error(s), got " + errors.length + (errors.length ? ":\n    " + errors.join("\n    ") : ""));
      continue;
    }
    if (testCase.expectMessageIncludes) {
      const joined = errors.join("\n");
      for (const needle of testCase.expectMessageIncludes) {
        if (!joined.includes(needle)) {
          failed += 1;
          console.error(
            "  FAIL " + testCase.name + ": expected the error message to include \"" + needle +
            "\". Got:\n    " + joined);
        }
      }
    }
  }

  for (const testCase of END_TO_END) {
    const { status, output } = runInTempTree(testCase.files, testCase.createDir !== false);
    if (status !== testCase.expectStatus) {
      failed += 1;
      console.error(
        "  FAIL " + testCase.name + ": expected exit " + testCase.expectStatus +
        ", got " + status + ". Output was:\n" + output);
      continue;
    }
    if (!output.includes(testCase.expectOutput)) {
      failed += 1;
      console.error(
        "  FAIL " + testCase.name + ": exit code was right but the message was not. Expected to " +
        "find \"" + testCase.expectOutput + "\". Output was:\n" + output);
    }
  }

  const total = CASES.length + END_TO_END.length;
  if (failed) {
    console.error(
      "migration Requires-header self-test FAILED: " + failed + " of " + total + " case(s).");
    process.exit(1);
  }
  console.log(
    "migration Requires-header self-test OK: " + total + " cases pass (" + CASES.length +
    " over the parser and comparison, " + END_TO_END.length + " running this script for real " +
    "in a throwaway tree). The gate was watched exiting 1 on a missing prerequisite, on an " +
    "empty migrations directory and on a missing one, and exiting 0 on a satisfied tree.");
}

/* ------------------------------------------------------------------------ main ------ */

if (process.argv.includes("--selftest")) {
  selftest();
} else {
  if (!existsSync(MIGRATIONS_DIR)) {
    console.error(
      "::error::" + MIGRATIONS_DIR + " does not exist, so this check examined nothing. That is " +
      "a failure and not a pass. Fix the path or the checkout.");
    process.exit(1);
  }

  let names;
  try {
    names = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
  } catch (err) {
    console.error(
      "::error::could not read " + MIGRATIONS_DIR + " (" + err.message + "). Whether every " +
      "Requires header is satisfied is UNKNOWN, which is not the same fact as satisfied.");
    process.exit(1);
  }

  const files = names.map((name) => ({ name, content: readFileSync(join(MIGRATIONS_DIR, name), "utf8") }));
  const { errors, checked, requiresSeen } = verdict(files);

  if (!files.length) {
    console.error(
      "::error::the migration Requires-header check enumerated 0 file(s) under " + MIGRATIONS_DIR +
      ". It proved nothing, so it is red rather than green.");
    process.exit(1);
  }

  if (errors.length) {
    console.error("unsatisfied -- Requires: header(s):");
    for (const message of errors) console.error("  " + message);
    console.error(
      "\nA -- Requires: header is a merge-order constraint: the file that carries it must not " +
      "merge to dev ahead of the file that creates the version it names. Merge the prerequisite " +
      "pull request first, or correct the version if it was named wrong.");
    process.exit(1);
  }

  console.log(
    "migration Requires-header check OK: " + checked + " migration file(s) enumerated, " +
    requiresSeen + " \"-- Requires:\" declaration(s) found, every one satisfied in this tree.");
}
