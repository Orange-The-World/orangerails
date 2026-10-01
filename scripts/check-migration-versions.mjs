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
 * (Comment-only touch 2026-09-05 to refresh a wedged Cloudflare Pages preview check; no
 * behavior change.)
 *
 * ONE COPY OF THIS DECISION, CALLED FROM TWO PLACES (OR-T1166). The pull request gate in ci.yml
 * runs this script before anything is applied anywhere. The check-duplicate-migrations job in
 * the deploy workflow runs the same script, and apply-migrations needs that job, so a colliding
 * pair stops the apply (OR-T1189). That job used to carry its own shell copy of the comparison,
 * and the two had drifted: the shell copy passed on a missing directory and on a directory with
 * no .sql file, which this script treats as hard failures.
 *
 * The apply step in the deploy workflow still derives each file's version in shell
 * (`basename | cut -d_ -f1`), and that is the rule that decides what gets skipped.
 * extractVersion below reproduces it rather than asserting a tidier rule of its own, and the
 * self test pins that, including the ugly corner where a name has no underscore. If you tighten
 * one, read the other in the same change.
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
 * IT CANNOT PASS BY LOOKING AT NOTHING. A missing directory, a directory that cannot be listed
 * and an enumeration of zero .sql files are all hard failures. A check that reports OK when it
 * examined nothing is the exact shape of control this repo keeps finding and removing, so this
 * one refuses to be that.
 *
 * Run `node scripts/check-migration-versions.mjs --selftest` to exercise the logic itself. CI
 * runs the self test BEFORE the check, so a broken comparison fails as a broken comparison
 * rather than as a silent pass over every migration.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = "supabase/migrations";

/**
 * Append a GitHub Actions step summary block, if GITHUB_STEP_SUMMARY is set. Never throws:
 * a step summary is a nicety, and a filesystem hiccup writing it must never turn a real pass
 * into a reported failure, or swallow a real failure behind an unrelated exception.
 *
 * OR-T1166. This script is invoked by both the pull request gate (ci.yml, where nothing has
 * been applied to any database yet) and the push time deploy job
 * (supabase-deploy.yml's check-duplicate-migrations, which used to format this same markdown
 * inline in shell). Moving that job onto this shared script would silently drop its step
 * summary unless the summary write moves here too, so it is folded into the one place the
 * decision itself already lives.
 */
function writeStepSummary(markdown) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, markdown);
  } catch {
    // See the comment above: never let this throw change the exit code.
  }
}

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
 * expectSummary lists text the GitHub step summary must contain after the run (OR-T1166). The
 * deploy job relies on that summary to name every colliding file, so it is asserted here, on
 * every run, instead of being shown once by a deliberate bad push.
 *
 * Note what was NOT added to make this possible: an environment variable pointing the gate at
 * a different directory. That is a bypass, and a bypass is worth more to whoever wants past
 * the gate than the gate is worth to us. The child gets a working directory instead, which
 * nothing in CI can set.
 */
const END_TO_END = [
  {
    name: "a real tree with a collision exits 1 and names every colliding file in the summary",
    files: ["20260831120000_a.sql", "20260831120000_b.sql"],
    expectStatus: 1,
    expectOutput: "duplicate migration version",
    expectSummary: [
      "Duplicate migration version(s)",
      "20260831120000_a.sql",
      "20260831120000_b.sql",
      "push again",
      "No migration has been applied by this run",
    ],
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
    expectSummary: ["enumerated 0 file(s)"],
  },
  {
    name: "no migrations directory at all exits 1, it does not pass",
    files: [],
    createDir: false,
    expectStatus: 1,
    expectOutput: "does not exist",
    expectSummary: ["could not run"],
  },
  {
    // supabase/migrations exists but is a regular file, so existsSync passes and readdirSync
    // throws. This reaches the unreadable-directory path without chmod, which does nothing when
    // the self test runs as root.
    name: "a migrations path that exists but cannot be listed exits 1 and says so in the summary",
    files: [],
    asFile: true,
    expectStatus: 1,
    expectOutput: "could not read",
    expectSummary: [
      "could not read the migrations directory",
      "No migration has been applied by this run",
    ],
  },
];

function runInTempTree(files, createDir, asFile = false) {
  const root = mkdtempSync(join(tmpdir(), "migration-version-gate-"));
  try {
    if (asFile) {
      mkdirSync(dirname(join(root, MIGRATIONS_DIR)), { recursive: true });
      writeFileSync(
        join(root, MIGRATIONS_DIR), "-- self-test fixture: a file where a directory belongs\n");
    } else if (createDir) {
      mkdirSync(join(root, MIGRATIONS_DIR), { recursive: true });
      for (const name of files) {
        writeFileSync(join(root, MIGRATIONS_DIR, name), "-- self-test fixture, never applied\n");
      }
    }
    // Point the child's step summary at a file inside the throwaway tree (OR-T1166). Without
    // this, a self-test run inside a real GitHub Actions job would inherit the real
    // GITHUB_STEP_SUMMARY and every fixture case would append its throwaway markdown to that
    // job's own summary. Reading the file back is also what lets a case assert the summary
    // contract itself.
    const summaryPath = join(root, "step-summary.md");
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath },
    });
    if (run.error) throw run.error;
    const summary = existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : "";
    return {
      status: run.status,
      output: (run.stdout ?? "") + (run.stderr ?? ""),
      summary,
    };
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
    const { status, output, summary } = runInTempTree(
      testCase.files, testCase.createDir !== false, testCase.asFile === true);
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
    for (const needle of testCase.expectSummary ?? []) {
      if (!summary.includes(needle)) {
        failed += 1;
        console.error(
          "  FAIL " + testCase.name + ": the step summary did not contain \"" + needle +
          "\". Summary was:\n" + summary);
      }
    }
  }

  const total = CASES.length + END_TO_END.length;
  if (failed) {
    console.error(
      "migration version self-test FAILED: " + failed + " failure(s) across " + total + " case(s).");
    process.exit(1);
  }
  console.log(
    "migration version self-test OK: " + total + " cases pass (" + CASES.length +
    " over the comparison, " + END_TO_END.length + " running this script for real in a " +
    "throwaway tree). The gate was watched exiting 1 on a collision, on an empty migrations " +
    "directory, on a missing one and on one that exists but cannot be listed, and exiting 0 on " +
    "a clean tree. Each failing run's GitHub step summary was read back, and on a collision it " +
    "named every colliding file.");
}

/* ------------------------------------------------------------------------ main ------ */

if (process.argv.includes("--selftest")) {
  selftest();
} else {
  if (!existsSync(MIGRATIONS_DIR)) {
    writeStepSummary(
      "## :rotating_light: Migration version check could not run\n\n" +
      "`" + MIGRATIONS_DIR + "` does not exist in this checkout, so nothing was compared. " +
      "That is treated as a failure, not a pass: fix the path or the checkout.\n");
    console.error(
      "::error::" + MIGRATIONS_DIR + " does not exist, so this check examined nothing. That is " +
      "a failure and not a pass. Fix the path or the checkout.");
    process.exit(1);
  }

  let names;
  try {
    names = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
  } catch (err) {
    writeStepSummary(
      "## :rotating_light: Migration version check could not read the migrations directory\n\n" +
      "`" + MIGRATIONS_DIR + "` exists but could not be listed (`" + err.message + "`). The " +
      "migration set is UNKNOWN, which is not the same fact as unique, so this is treated as a " +
      "failure and not a pass. No migration has been applied by this run.\n");
    console.error(
      "::error::could not read " + MIGRATIONS_DIR + " (" + err.message + "). The migration set " +
      "is UNKNOWN, which is not the same fact as unique.");
    process.exit(1);
  }

  const { errors, checked, duplicates } = verdict(names);

  if (!duplicates.length && errors.length) {
    // The directory is there and holds no .sql file. Nothing to compare is UNKNOWN, and
    // UNKNOWN must never borrow the vocabulary of a clean result or of a collision.
    writeStepSummary(
      "## :rotating_light: Migration version check enumerated 0 file(s)\n\n" +
      "`" + MIGRATIONS_DIR + "` exists but contains no `.sql` file. That proves nothing about " +
      "uniqueness, so this is reported as a failure rather than a silent pass.\n");
    for (const message of errors) console.error(message);
    console.error(
      "::error::the migration version check enumerated 0 file(s) under " + MIGRATIONS_DIR +
      ". It proved nothing, so it is red rather than green.");
    process.exit(1);
  }

  if (duplicates.length) {
    let summary = "## :rotating_light: Duplicate migration version(s)\n\n";
    for (const dupe of duplicates) {
      summary += "`" + dupe.version + "` is used by more than one file:\n\n";
      for (const file of dupe.files) summary += "- `" + file + "`\n";
      summary += "\n";
    }
    summary +=
      "`supabase_migrations.schema_migrations` stores one row per version, so at most one " +
      "of these can ever be tracked and the rest are reported as applied whether they ran " +
      "or not. Rename the later file to an unused timestamp and push again. No migration " +
      "has been applied by this run.\n";
    writeStepSummary(summary);

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
