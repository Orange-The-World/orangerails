#!/usr/bin/env node
/**
 * CI gate: a migration that declares -- Requires: <version> must find that version's
 * file already in the tree being checked.
 *
 * WHY THIS EXISTS. OR-T1170 asked whether a migration-to-migration dependency should live
 * only in the promotion runbook or be made mechanical. Release ruled: mechanical, with the
 * runbook line kept as well. The dependency that motivated this
 * (20260831120000 needs 20260831071500) is invisible on dev: the assertion inside the
 * dependent file passes on hosted dev whenever the prerequisite column reached that project
 * out of band, so the promoter sees a green dev and is never prompted to remember anything.
 * A runbook line only helps a promoter who already suspects there is something to look up.
 * A check that runs on every pull request does not require anyone to suspect it.
 *
 * THE HEADER CONVENTION. A migration file may carry, on a line of its own,
 *   -- Requires: 20260831071500
 * zero or more times, naming migration VERSIONS it depends on and does not itself create.
 *
 * WHAT THIS PROVES: every version named in a -- Requires: line, across every file under
 * supabase/migrations, has a matching supabase/migrations/<version>_*.sql file in this tree.
 *
 * WHY TREE PRESENCE IS SUFFICIENT, and this is the load-bearing argument. The constraint is a
 * MERGE-ORDER constraint on dev, not an apply-order constraint on prod. Version numbers
 * already order the apply correctly on every project once both files are in the tree. The
 * only way the ordering fails is a tree that contains the dependent file and not the
 * prerequisite, so "is the prerequisite file present" is the whole question, and it is
 * answerable from the tree alone with no database connection, no ledger read and no
 * environment credentials.
 *
 * WHAT THIS DOES NOT PROVE, and nobody should read it as proving. It does not infer a
 * dependency automatically by parsing SQL for column or table references: that needs a real
 * SQL parser to avoid false positives on comments and strings, cannot see through plpgsql
 * runtime field resolution (the exact mechanism that made this class of bug silent in the
 * first place), and a check that fires wrongly gets disabled. A declared header is honest
 * about being a declaration: it enforces what an author states, and does not pretend to
 * discover what an author forgot. A missing -- Requires: line is not caught by this check.
 * It also says nothing about apply ORDER (that is OR-T0419 / the order guard in
 * supabase-deploy.yml) and nothing about a version recorded in a ledger by hand.
 *
 * IT CANNOT PASS BY LOOKING AT NOTHING. A missing migrations directory and an enumeration of
 * zero .sql files are both hard failures, the same standard scripts/check-migration-versions.mjs
 * holds itself to.
 *
 * Run `node scripts/check-migration-requires.mjs --selftest` to exercise the logic itself. CI
 * runs the self test BEFORE the check, so a broken comparison fails as a broken comparison
 * rather than as a silent pass over every migration.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = "supabase/migrations";

// Same extraction the apply job and check-migration-versions.mjs use: everything before the
// FIRST underscore. The three must agree on what a "version" is, or a file could satisfy one
// and not the others.
export function extractVersion(basename) {
  const cut = basename.indexOf("_");
  return cut === -1 ? basename : basename.slice(0, cut);
}

// A line of the form `-- Requires: <version>` at column one. Anchored and exact on purpose:
// this is a declaration an author writes deliberately, not prose this script goes hunting
// for inside a paragraph.
const REQUIRES_LINE = /^-- Requires: (\S+)\s*$/;

/**
 * The versions a single migration file's content declares it requires, in the order they
 * appear. A pure function over text so the self test can drive it without touching disk.
 */
export function declaredRequires(content) {
  const versions = [];
  for (const line of content.split(/\r?\n/)) {
    const match = REQUIRES_LINE.exec(line);
    if (match) versions.push(match[1]);
  }
  return versions;
}

/**
 * The whole decision, as a pure function over { name, content } pairs, so the self test
 * exercises the real comparison and not a paraphrase of it.
 *
 * files: array of { name, content }.
 * Returns { errors, checked, requiresChecked }.
 */
export function verdict(files) {
  const errors = [];

  if (files.length === 0) {
    errors.push(
      "no .sql file was found under " + MIGRATIONS_DIR + ". This check enumerated nothing, so " +
      "it proved nothing. Fix the path or the checkout rather than reading this as a pass.");
    return { errors, checked: 0, requiresChecked: 0 };
  }

  const present = new Set(files.map((f) => extractVersion(f.name)));
  let requiresChecked = 0;

  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    for (const required of declaredRequires(file.content)) {
      requiresChecked += 1;
      if (!present.has(required)) {
        errors.push(
          file.name + " declares \"-- Requires: " + required + "\" but no " + MIGRATIONS_DIR +
          "/" + required + "_*.sql file exists in this tree. Either the prerequisite pull " +
          "request has not merged yet, or the required version is wrong.");
      }
    }
  }

  return { errors, checked: files.length, requiresChecked };
}

/* ------------------------------------------------------------------- self test ------ */

const CASES = [
  {
    name: "a file with no -- Requires: line at all passes",
    files: [{ name: "20260831120000_a.sql", content: "select 1;\n" }],
    expectErrors: 0,
  },
  {
    name: "a declared requirement that is present passes",
    files: [
      { name: "20260831071500_prereq.sql", content: "select 1;\n" },
      { name: "20260831120000_dependent.sql", content: "-- Requires: 20260831071500\nselect 1;\n" },
    ],
    expectErrors: 0,
  },
  {
    name: "a declared requirement with no matching file fails, naming the file and the version",
    files: [
      { name: "20260831120000_dependent.sql", content: "-- Requires: 20260831071500\nselect 1;\n" },
    ],
    expectErrors: 1,
    expectMessageContains: ["20260831120000_dependent.sql", "20260831071500"],
  },
  {
    name: "two requires lines, one present and one missing, reports exactly the missing one",
    files: [
      { name: "20260831071500_prereq.sql", content: "select 1;\n" },
      {
        name: "20260831120000_dependent.sql",
        content: "-- Requires: 20260831071500\n-- Requires: 20260830000000\nselect 1;\n",
      },
    ],
    expectErrors: 1,
    expectMessageContains: ["20260830000000"],
  },
  {
    name: "two different files each missing their own prerequisite are two findings",
    files: [
      { name: "20260831120000_a.sql", content: "-- Requires: 20260101000000\nselect 1;\n" },
      { name: "20260831130000_b.sql", content: "-- Requires: 20260102000000\nselect 1;\n" },
    ],
    expectErrors: 2,
  },
  {
    name: "Requires is matched at column one only, not inside a comment sentence",
    files: [
      {
        name: "20260831120000_a.sql",
        content: "-- see the notes on what this Requires: nothing special\nselect 1;\n",
      },
    ],
    expectErrors: 0,
  },
  {
    name: "a self-referencing Requires is satisfied by the file's own version",
    // Not endorsed, not forbidden either: the file's own version is trivially "present" the
    // moment it exists in the tree, so this is what the tree-presence check can see. A richer
    // rule (a file may not require itself) is a different, sharper check this ticket does not
    // build; see the module header for why an inferred rule is refused here.
    files: [{ name: "20260831120000_a.sql", content: "-- Requires: 20260831120000\nselect 1;\n" }],
    expectErrors: 0,
  },
];

/**
 * End to end cases. These run THIS SCRIPT, as CI runs it, against a throwaway tree, the same
 * standard scripts/check-migration-versions.mjs holds itself to: a gate nobody has watched go
 * red is not evidence.
 */
const END_TO_END = [
  {
    name: "a missing prerequisite exits 1 and names the file and the missing version",
    files: {
      "20260831120000_dependent.sql": "-- Requires: 20260831071500\nselect 1;\n",
    },
    expectStatus: 1,
    expectOutput: "20260831071500",
  },
  {
    name: "a satisfied prerequisite exits 0",
    files: {
      "20260831071500_prereq.sql": "select 1;\n",
      "20260831120000_dependent.sql": "-- Requires: 20260831071500\nselect 1;\n",
    },
    expectStatus: 0,
    expectOutput: "migration dependency check OK",
  },
  {
    name: "no -- Requires: lines anywhere exits 0",
    files: { "20260831120000_a.sql": "select 1;\n" },
    expectStatus: 0,
    expectOutput: "migration dependency check OK",
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

function runInTempTree(files, createDir) {
  const root = mkdtempSync(join(tmpdir(), "migration-requires-gate-"));
  try {
    if (createDir) {
      mkdirSync(join(root, MIGRATIONS_DIR), { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(root, MIGRATIONS_DIR, name), content);
      }
    }
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
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
    if (testCase.expectMessageContains) {
      const joined = errors.join("\n");
      for (const needle of testCase.expectMessageContains) {
        if (!joined.includes(needle)) {
          failed += 1;
          console.error(
            "  FAIL " + testCase.name + ": expected the error text to contain \"" + needle +
            "\" but it did not. Got:\n    " + joined);
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
      "migration dependency self-test FAILED: " + failed + " of " + total + " case(s).");
    process.exit(1);
  }
  console.log(
    "migration dependency self-test OK: " + total + " cases pass (" + CASES.length +
    " over the comparison, " + END_TO_END.length + " running this script for real in a " +
    "throwaway tree). The gate was watched exiting 1 on a missing prerequisite, on an empty " +
    "migrations directory and on a missing one, and exiting 0 on a satisfied or absent " +
    "requirement.");
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
      "::error::could not read " + MIGRATIONS_DIR + " (" + err.message + "). The dependency " +
      "set is UNKNOWN, which is not the same fact as satisfied.");
    process.exit(1);
  }

  const files = names.map((name) => ({
    name,
    content: readFileSync(join(MIGRATIONS_DIR, name), "utf8"),
  }));

  const { errors, checked, requiresChecked } = verdict(files);

  if (files.length === 0) {
    for (const message of errors) console.error(message);
    console.error(
      "::error::the migration dependency check enumerated 0 file(s) under " + MIGRATIONS_DIR +
      ". It proved nothing, so it is red rather than green.");
    process.exit(1);
  }

  if (errors.length) {
    console.error("unsatisfied migration dependency (or dependencies) found:");
    for (const message of errors) console.error("  " + message);
    console.error(
      "\nA -- Requires: header declares a merge-order constraint on this branch: the named " +
      "version's file must already be in the tree. If the prerequisite pull request has not " +
      "merged yet, merge it first. If the version named is simply wrong, correct the header.");
    console.error("::error::unsatisfied migration dependency: see the list above.");
    process.exit(1);
  }

  console.log(
    "migration dependency check OK: " + checked + " migration file(s) enumerated, " +
    requiresChecked + " -- Requires: declaration(s) checked, every named version present in " +
    "this tree.");
}
