#!/usr/bin/env node
/**
 * CI gate: two files under supabase/migrations must never share a version prefix.
 *
 * WHY THIS EXISTS. The version of a migration is its file name prefix, and
 * supabase_migrations.schema_migrations holds exactly ONE row per version. The apply job in
 * .github/workflows/supabase-deploy.yml derives that version from the base name by taking
 * everything before the first underscore, then skips any file whose version is already in the
 * ledger. So when two files carry the same prefix, the first one to apply writes the row and
 * every later file with that prefix is treated as applied and is silently skipped. The failure
 * never renders as a red migration. It renders weeks later as an object that does not exist on
 * a cluster whose ledger says it is up to date.
 *
 * On 2026-08-31 two open pull requests both carried version 20260831120000 and CI was green on
 * both, because nothing on the pull request path looked at migration file names at all.
 *
 * WHERE THE OTHER COPY OF THIS DECISION LIVES, and why it was not enough on its own. The
 * check-pending-migrations job in the deploy workflow already refuses a duplicate version. Two
 * limits: it runs on a push to dev or prod and never on a pull request, and within that
 * workflow it runs AFTER apply-migrations. By the time it goes red the shadowed file has
 * already been skipped against a real database. This gate runs on the pull request, before
 * anything is applied anywhere.
 *
 * The two must agree. extractVersion below reproduces what that workflow does in shell
 * (`basename | cut -d_ -f1`) rather than asserting a tidier rule of its own, and the self test
 * pins that, including the ugly corner where a name has no underscore. If you tighten one, read
 * the other in the same change.
 *
 * WHAT THIS PROVES: every version prefix present under supabase/migrations on this tree is
 * unique.
 *
 * WHAT IT DOES NOT PROVE, and nobody should read it as proving. It says nothing about whether a
 * version is well formed, and nothing about ORDER. A migration that merges late while numbering
 * early still applies after everything above it, which is a separate defect tracked by OR-T0419.
 * Uniqueness is the cheaper half and is deliberately not held back for the other one. It also
 * reads the tree, not a database: a version recorded in a ledger by hand is not visible here.
 *
 * IT CANNOT PASS BY LOOKING AT NOTHING. A missing directory and an enumeration of zero .sql
 * files are both hard failures. A check that reports OK when it examined nothing is the exact
 * shape of control this repo keeps finding and removing, so this one refuses to be that.
 *
 * Run `node scripts/check-migration-versions.mjs --selftest` to exercise the logic itself. CI
 * runs the self test BEFORE the check, so a broken comparison fails as a broken comparison
 * rather than as a silent pass over every migration.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = "supabase/migrations";

/**
 * The version the apply job will use, byte for byte.
 *
 * The workflow does `VERSION="${BASENAME%%_*}"`, which is everything before the FIRST
 * underscore, with no validation whatsoever. This function is not allowed to be smarter than
 * that: if it required 14 digits and the workflow did not, a file the workflow shadows could
 * pass here, which is worse than no check at all.
 */
export function extractVersion(basename) {
  const cut = basename.indexOf("_");
  return cut === -1 ? basename : basename.slice(0, cut);
}

/**
 * The whole decision, as a pure function over file names, so the self test exercises the real
 * comparison and not a paraphrase of it.
 *
 * Returns { errors, checked, duplicates }. errors is empty only when the gate passes.
 */
export function verdict(names) {
  const errors = [];

  if (names.length === 0) {
    errors.push(
      "no .sql file was found under " + MIGRATIONS_DIR + ". This check enumerated nothing, so " +
      "it proved nothing. Fix the path or the checkout rather than reading this as a pass.");
    return { errors, checked: 0, duplicates: [] };
  }

  const byVersion = new Map();
  for (const name of [...names].sort()) {
    const version = extractVersion(name);
    if (!byVersion.has(version)) byVersion.set(version, []);
    byVersion.get(version).push(name);
  }

  const duplicates = [...byVersion.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([version, files]) => ({ version, files }));

  for (const dupe of duplicates) {
    errors.push(
      "version " + dupe.version + " is used by " + dupe.files.length + " files: " +
      dupe.files.join(", "));
  }

  return { errors, checked: names.length, duplicates };
}

/* ------------------------------------------------------------------- self test ------ */

const CASES = [
  {
    name: "an empty enumeration is a failure, never a pass",
    names: [],
    expectErrors: 1,
  },
  {
    name: "distinct versions pass",
    names: [
      "20260831120000_add_a_column.sql",
      "20260831130000_revoke_a_grant.sql",
    ],
    expectErrors: 0,
  },
  {
    name: "the same version on two files fails",
    names: [
      "20260831120000_user_vault_meta_keyring_epoch.sql",
      "20260831120000_revoke_public_vault_workspace_key_guard.sql",
    ],
    expectErrors: 1,
  },
  {
    name: "three files on one version are reported once, naming all three",
    names: [
      "20260831120000_a.sql",
      "20260831120000_b.sql",
      "20260831120000_c.sql",
    ],
    expectErrors: 1,
    expectFiles: 3,
  },
  {
    name: "two separate collisions are two findings",
    names: [
      "20260831120000_a.sql",
      "20260831120000_b.sql",
      "20260831130000_c.sql",
      "20260831130000_d.sql",
    ],
    expectErrors: 2,
  },
  {
    name: "the version is everything before the FIRST underscore, not the last",
    names: [
      "20260831120000_one_two_three.sql",
      "20260831120000_four.sql",
    ],
    expectErrors: 1,
  },
  {
    name: "a name with no underscore keeps its extension, exactly as the apply job does",
    // Not an endorsement: such a file can never match a ledger row and would replay on every
    // run. That is a different defect. What is pinned here is that this gate copies the
    // workflow's extraction rather than inventing a stricter one of its own, so the two can
    // never disagree about what a version IS.
    names: [
      "20260831120000.sql",
      "20260831120000_real.sql",
    ],
    expectErrors: 0,
  },
  {
    name: "identical suffixes on different versions are fine",
    names: [
      "20260831120000_rename_thing.sql",
      "20260901090000_rename_thing.sql",
    ],
    expectErrors: 0,
  },
];

/**
 * End to end cases. These run THIS SCRIPT, as CI runs it, against a throwaway tree.
 *
 * The cases above prove the comparison is right. They do not prove the thing CI invokes can
 * fail: the enumeration, the exit codes, and the two hard-failure paths all live outside
 * verdict(), and those are precisely where a check decays into a green tick over nothing. A
 * gate nobody has watched go red is not evidence, so this watches it, on every run, rather
 * than once in a ticket that ages.
 *
 * Note what was NOT added to make this possible: an environment variable pointing the gate at
 * a different directory. That is a bypass, and a bypass is worth more to whoever wants past
 * the gate than the gate is worth to us. The child gets a working directory instead, which
 * nothing in CI can set.
 */
const END_TO_END = [
  {
    name: "a real tree with a collision exits 1 and says so",
    files: ["20260831120000_a.sql", "20260831120000_b.sql"],
    expectStatus: 1,
    expectOutput: "duplicate migration version",
  },
  {
    name: "a real tree with unique versions exits 0",
    files: ["20260831120000_a.sql", "20260831130000_b.sql"],
    expectStatus: 0,
    expectOutput: "migration version check OK",
  },
  {
    name: "an empty migrations directory exits 1, it does not pass",
    files: [],
    expectStatus: 1,
    expectOutput: "enumerated 0 file(s)",
  },
  {
    name: "no migrations directory at all exits 1, it does not pass",
    files: [],
    createDir: false,
    expectStatus: 1,
    expectOutput: "does not exist",
  },
];

function runInTempTree(files, createDir) {
  const root = mkdtempSync(join(tmpdir(), "migration-version-gate-"));
  try {
    if (createDir) {
      mkdirSync(join(root, MIGRATIONS_DIR), { recursive: true });
      for (const name of files) {
        writeFileSync(join(root, MIGRATIONS_DIR, name), "-- self-test fixture, never applied\n");
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
    const { errors, duplicates } = verdict(testCase.names);
    if (errors.length !== testCase.expectErrors) {
      failed += 1;
      console.error(
        "  FAIL " + testCase.name + ": expected " + testCase.expectErrors +
        " error(s), got " + errors.length);
      continue;
    }
    if (testCase.expectFiles !== undefined) {
      const named = duplicates.reduce((total, dupe) => total + dupe.files.length, 0);
      if (named !== testCase.expectFiles) {
        failed += 1;
        console.error(
          "  FAIL " + testCase.name + ": expected " + testCase.expectFiles +
          " file(s) named in the finding, got " + named);
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
      "migration version self-test FAILED: " + failed + " of " + total + " case(s).");
    process.exit(1);
  }
  console.log(
    "migration version self-test OK: " + total + " cases pass (" + CASES.length +
    " over the comparison, " + END_TO_END.length + " running this script for real in a " +
    "throwaway tree). The gate was watched exiting 1 on a collision, on an empty migrations " +
    "directory and on a missing one, and exiting 0 on a clean tree.");
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
      "::error::could not read " + MIGRATIONS_DIR + " (" + err.message + "). The migration set " +
      "is UNKNOWN, which is not the same fact as unique.");
    process.exit(1);
  }

  const { errors, checked, duplicates } = verdict(names);

  if (!duplicates.length && errors.length) {
    // The directory is there and holds no .sql file. Nothing to compare is UNKNOWN, and
    // UNKNOWN must never borrow the vocabulary of a clean result or of a collision.
    for (const message of errors) console.error(message);
    console.error(
      "::error::the migration version check enumerated 0 file(s) under " + MIGRATIONS_DIR +
      ". It proved nothing, so it is red rather than green.");
    process.exit(1);
  }

  if (duplicates.length) {
    console.error("duplicate migration version(s) found:");
    for (const dupe of duplicates) {
      console.error("  version " + dupe.version + " is used by " + dupe.files.length + " files:");
      for (const file of dupe.files) console.error("    - " + file);
    }
    console.error(
      "\nsupabase_migrations.schema_migrations stores one row per version, so at most one of " +
      "the files above can ever be tracked. The rest are reported as applied whether they ran " +
      "or not, on every project, forever. Rename the later file to an unused timestamp.");
    console.error(
      "::error::duplicate migration version(s): " +
      duplicates.map((d) => d.version).join(", ") + ". See the list above.");
    process.exit(1);
  }

  console.log(
    "migration version check OK: " + checked + " migration file(s) enumerated, every version " +
    "prefix unique. This says nothing about apply ORDER (OR-T0419) and nothing about versions " +
    "recorded in a ledger outside this tree.");
}
