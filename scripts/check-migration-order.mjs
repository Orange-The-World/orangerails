#!/usr/bin/env node
/**
 * CI gate: a pull request must not add a migration that numbers below one already on the base
 * branch, unless it says in the file why applying it late is safe.
 *
 * WHY THIS EXISTS, and why the existing guard was not enough. The apply job in
 * .github/workflows/supabase-deploy.yml already refuses an out-of-order migration, and it has
 * a self test with ten cases. It runs on `push` to dev and prod. It does not run on a pull
 * request. So a pull request can be green, approved, and report mergeStateStatus CLEAN while
 * carrying a file that will make the apply job refuse the WHOLE run the moment it lands, not
 * just that one file: apply-migrations fails, check-pending-migrations fails, deploy is
 * skipped, and every unrelated change queued behind it stops with them.
 *
 * That is not hypothetical and it is not rare. On 2026-09-05 dev spent most of the day in
 * exactly that state, and a sweep of the open pull requests that afternoon found SIXTEEN more
 * queued to do it again, one of which was already approved and one button from merging. Nobody
 * had done anything wrong on any of those pull requests. Nothing told them.
 *
 * The defect itself is OR-T0419: migrations are applied in filename order within ONE run, so a
 * file that merges late while numbering early applies after everything numbered above it, in
 * an order nobody wrote down and nobody reviewed.
 *
 * WHAT THIS COMPARES AGAINST, and why it is the base tree rather than a database. The deploy
 * guard compares each pending file against the highest version in
 * supabase_migrations.schema_migrations. This check cannot read that ledger: it runs on a pull
 * request, where handing out a database credential to get one integer would be a much worse
 * trade than the check is worth. It compares against the highest migration version present on
 * the BASE branch tree instead.
 *
 * Those two are not the same number in principle, and the difference is worth stating rather
 * than glossing. The tree can be AHEAD of the ledger, by exactly the files that are merged but
 * not yet applied. Whenever it is, this check is STRICTER than the deploy guard: it can refuse
 * a file the deploy guard would have allowed. Measured on 2026-09-05, dev's tree maximum and
 * its applied maximum were the same version, 20260904150000, so the window was zero files
 * wide. If a backlog opens that window again, this check errs toward refusing early, which is
 * the cheap direction: the cost is a marker line on a pull request, and the cost of the other
 * direction is the whole deploy pipeline.
 *
 * It is also the more honest comparison for a pull request. The thing being reviewed is
 * "does this file number below something that is already merged", which is a fact about the
 * tree, and it stays true whether or not the ledger has caught up yet.
 *
 * THE ESCAPE HATCH IS THE SAME ONE THE DEPLOY GUARD USES, deliberately, so an author who
 * satisfies one satisfies the other. A file may number below the maximum if it carries
 *
 *     -- OUT-OF-ORDER-OK: <reason>
 *
 * at column one with a non-empty reason. The deploy guard extracts that reason with
 * `sed ... | head -1`, so the FIRST such line decides and it must carry a complete reason on
 * its own; detail belongs on following plain `--` lines that do not repeat the token. This
 * check reproduces that rule rather than inventing a tidier one of its own, including reading
 * only the first marker line, because a file that passes here and is then refused on dev would
 * be worse than no check at all.
 *
 * The workflow's OUT_OF_ORDER_ALLOWLIST is also honoured, for the same reason.
 *
 * WHAT THIS PROVES: no migration added by this pull request numbers below the highest
 * migration already on the base branch without saying why that is safe.
 *
 * WHAT IT DOES NOT PROVE. It says nothing about whether a stated reason is TRUE. A reason is a
 * claim by the author that a reviewer can read and disagree with, and making it visible in the
 * diff is the entire point; a gate cannot check it. It also says nothing about uniqueness,
 * which is scripts/check-migration-versions.mjs, and nothing about a version recorded in a
 * ledger by hand and present in no tree.
 *
 * AND IT CANNOT PASS BY LOOKING AT NOTHING. If the base ref is unreachable, or the migrations
 * directory is missing, or the base tree holds no migration at all, this exits non-zero and
 * says the comparison is UNKNOWN. A check that reports OK when it compared against nothing is
 * the exact shape of control this repository keeps finding and removing. A pull request that
 * adds no migration is the one legitimate way to pass without comparing, and it says so.
 *
 * Run `node scripts/check-migration-order.mjs --selftest` to exercise the logic itself. CI runs
 * the self test BEFORE the check, so a broken comparison fails as a broken comparison rather
 * than as a silent pass over every migration.
 */

import { spawnSync } from "node:child_process";

const MIGRATIONS_DIR = "supabase/migrations";

/**
 * Versions the deploy workflow already forgives, copied from OUT_OF_ORDER_ALLOWLIST in
 * .github/workflows/supabase-deploy.yml. These are files that were already merged out of order
 * before either guard existed. If you change one list, change the other in the same commit.
 */
export const ALLOWLIST = new Set([
  "20260713120001", "20260716120001", "20260717123000", "20260721120000", "20260722000001",
  "20260722130000", "20260722140000", "20260723120000", "20260723210000", "20260724180000",
  "20260730000000", "20260730120000", "20260730120001", "20260730200000", "20260802120000",
  "20260803000000", "20260803120000", "20260803140000", "20260803160000", "20260803190000",
  "20260804000000", "20260804000001", "20260804090000", "20260804140000", "20260806100000",
  "20260809130000", "20260815000001", "20260817230000", "20260819120000",
]);

/**
 * The version the apply job will use, byte for byte: everything before the FIRST underscore,
 * with no validation. Kept identical to extractVersion in check-migration-versions.mjs and to
 * `VERSION="${BASENAME%%_*}"` in the workflow. This function is not allowed to be smarter than
 * the thing it is predicting.
 */
export function extractVersion(basename) {
  const cut = basename.indexOf("_");
  return cut === -1 ? basename : basename.slice(0, cut);
}

/**
 * The reason on the first marker line, or null if there is no usable one.
 *
 * The workflow strips the token with a sed substitution and takes `head -1`. That head -1
 * is the part authors trip over: a reason spread across several lines gives the
 * workflow only the first line, so a first line that reads "see below" is an empty reason as
 * far as the gate is concerned. This reproduces that exactly, first match wins, rather than
 * scanning for the best-looking marker in the file.
 */
export function markerReason(contents) {
  for (const line of contents.split("\n")) {
    const match = /^--[ \t]*OUT-OF-ORDER-OK:[ \t]*(.*)$/.exec(line);
    if (match) return match[1].trim() || null;
  }
  return null;
}

/**
 * The whole decision, as a pure function, so the self test exercises the real comparison and
 * not a paraphrase of it.
 *
 * added        basenames of migration files this pull request ADDS to the base branch
 * baseMax      the highest migration version present on the base branch, or null if none
 * readContents (basename) => string, so the self test does not need a filesystem
 *
 * Returns { errors, refusals, acknowledged, compared }. errors is empty only when it passes.
 */
export function verdict(added, baseMax, readContents) {
  const errors = [];
  const refusals = [];
  const acknowledged = [];

  if (added.length === 0) {
    // The one legitimate way to pass without comparing anything. Say so explicitly rather
    // than printing the same OK line a real comparison prints.
    return { errors, refusals, acknowledged, compared: 0 };
  }

  if (!baseMax) {
    errors.push(
      "this pull request adds " + added.length + " migration(s) but no migration was found on " +
      "the base branch, so there is nothing to compare against. That is UNKNOWN, not clean: " +
      "the base checkout is wrong, or " + MIGRATIONS_DIR + " moved.");
    return { errors, refusals, acknowledged, compared: 0 };
  }

  for (const name of [...added].sort()) {
    const version = extractVersion(name);

    if (!/^[0-9]{14}$/.test(version)) {
      // Not a refusal to order it, a refusal to guess. An unparseable version compares
      // unpredictably against a numeric one, and the workflow would shadow it silently.
      errors.push(
        name + " has version \"" + version + "\", which is not 14 digits. This check cannot " +
        "order it and will not pretend to.");
      continue;
    }

    if (version > baseMax) continue;
    if (ALLOWLIST.has(version)) {
      acknowledged.push({ name, version, reason: "on the deploy workflow allowlist" });
      continue;
    }

    let contents;
    try {
      contents = readContents(name);
    } catch (err) {
      errors.push(
        "could not read " + name + " (" + err.message + "), so whether it carries a marker is " +
        "UNKNOWN. That is red, not green.");
      continue;
    }

    const reason = markerReason(contents);
    if (reason) {
      acknowledged.push({ name, version, reason });
      continue;
    }
    refusals.push({ name, version });
  }

  for (const refusal of refusals) {
    errors.push(
      refusal.name + " (version " + refusal.version + ") numbers at or below " + baseMax +
      ", which is already on the base branch, and carries no OUT-OF-ORDER-OK line.");
  }

  return { errors, refusals, acknowledged, compared: added.length };
}

/* ------------------------------------------------------------------- self test ------ */

const OK = "-- OUT-OF-ORDER-OK: this is a complete reason on one line (TICKET-1).\n";
const files = (map) => (name) => {
  if (!(name in map)) throw new Error("no such file");
  return map[name];
};

const CASES = [
  {
    name: "a pull request that adds no migration passes without comparing",
    added: [], baseMax: "20260904150000", contents: {},
    expectErrors: 0, expectRefusals: 0, expectCompared: 0,
  },
  {
    name: "adding migrations with no base migration at all is UNKNOWN, not a pass",
    added: ["20260904160000_a.sql"], baseMax: null, contents: { "20260904160000_a.sql": "" },
    expectErrors: 1, expectRefusals: 0,
  },
  {
    name: "the ordinary case: a version above the base maximum passes, silently, with no marker",
    added: ["20260904160000_a.sql"], baseMax: "20260904150000",
    contents: { "20260904160000_a.sql": "-- nothing special here\n" },
    expectErrors: 0, expectRefusals: 0, expectAcknowledged: 0,
  },
  {
    name: "a version below the base maximum with no marker is refused",
    added: ["20260828010000_a.sql"], baseMax: "20260904150000",
    contents: { "20260828010000_a.sql": "-- nothing special here\n" },
    expectErrors: 1, expectRefusals: 1,
  },
  {
    name: "a version EQUAL to the base maximum is refused: it is a duplicate as well as late",
    added: ["20260904150000_a.sql"], baseMax: "20260904150000",
    contents: { "20260904150000_a.sql": "-- nothing special here\n" },
    expectErrors: 1, expectRefusals: 1,
  },
  {
    name: "a version below the base maximum WITH a marker is acknowledged and passes",
    added: ["20260828010000_a.sql"], baseMax: "20260904150000",
    contents: { "20260828010000_a.sql": OK + "-- more detail on a plain line\n" },
    expectErrors: 0, expectRefusals: 0, expectAcknowledged: 1,
  },
  {
    name: "an EMPTY reason on the marker line is not a marker",
    added: ["20260828010000_a.sql"], baseMax: "20260904150000",
    contents: { "20260828010000_a.sql": "-- OUT-OF-ORDER-OK:\n-- the reason is down here\n" },
    expectErrors: 1, expectRefusals: 1,
  },
  {
    name: "only the FIRST marker line counts, matching sed | head -1 in the workflow",
    added: ["20260828010000_a.sql"], baseMax: "20260904150000",
    contents: { "20260828010000_a.sql": "-- OUT-OF-ORDER-OK:   \n" + OK },
    expectErrors: 1, expectRefusals: 1,
  },
  {
    name: "a marker that is not at column one does not count",
    added: ["20260828010000_a.sql"], baseMax: "20260904150000",
    contents: { "20260828010000_a.sql": "   -- OUT-OF-ORDER-OK: indented, so the workflow sed misses it.\n" },
    expectErrors: 1, expectRefusals: 1,
  },
  {
    name: "an allowlisted version passes with no marker and is still named in the log",
    added: ["20260721120000_a.sql"], baseMax: "20260904150000",
    contents: { "20260721120000_a.sql": "-- nothing special here\n" },
    expectErrors: 0, expectRefusals: 0, expectAcknowledged: 1,
  },
  {
    name: "a version that is not 14 digits is refused as uncomparable, not silently ordered",
    added: ["2026010100000X_a.sql"], baseMax: "20260904150000",
    contents: { "2026010100000X_a.sql": OK },
    expectErrors: 1, expectRefusals: 0,
  },
  {
    name: "an unreadable file is UNKNOWN and therefore red",
    added: ["20260828010000_a.sql"], baseMax: "20260904150000", contents: {},
    expectErrors: 1, expectRefusals: 0,
  },
  {
    name: "several files are each judged on their own, and all findings are reported at once",
    added: [
      "20260828010000_bad.sql",
      "20260828020000_good.sql",
      "20260904160000_fine.sql",
    ],
    baseMax: "20260904150000",
    contents: {
      "20260828010000_bad.sql": "-- nothing\n",
      "20260828020000_good.sql": OK,
      "20260904160000_fine.sql": "-- nothing\n",
    },
    expectErrors: 1, expectRefusals: 1, expectAcknowledged: 1,
  },
];

function selftest() {
  let failed = 0;
  for (const testCase of CASES) {
    const { errors, refusals, acknowledged, compared } =
      verdict(testCase.added, testCase.baseMax, files(testCase.contents));
    const check = (label, actual, expected) => {
      if (expected !== undefined && actual !== expected) {
        failed += 1;
        console.error(
          "  FAIL " + testCase.name + ": expected " + expected + " " + label + ", got " + actual +
          (errors.length ? ". Errors were:\n    " + errors.join("\n    ") : ""));
      }
    };
    check("error(s)", errors.length, testCase.expectErrors);
    check("refusal(s)", refusals.length, testCase.expectRefusals);
    check("acknowledged file(s)", acknowledged.length, testCase.expectAcknowledged);
    check("compared file(s)", compared, testCase.expectCompared);
  }

  if (failed) {
    console.error(
      "migration order self-test FAILED: " + failed + " assertion(s) over " + CASES.length +
      " case(s).");
    process.exit(1);
  }
  console.log(
    "migration order self-test OK: " + CASES.length + " cases pass. The comparison was watched " +
    "passing an ordinary in-order file with no marker, refusing a late file with no marker, " +
    "refusing an empty reason, refusing a second marker line after an empty first one, " +
    "refusing an indented marker, accepting a proper marker and an allowlisted version, and " +
    "going red rather than green on an uncomparable version, an unreadable file and a base " +
    "branch with no migrations at all.");
}

/* ------------------------------------------------------------------------ main ------ */

function git(args) {
  const run = spawnSync("git", args, { encoding: "utf8" });
  if (run.status !== 0) {
    throw new Error("git " + args.join(" ") + " failed: " + (run.stderr || "").trim());
  }
  return run.stdout;
}

if (process.argv.includes("--selftest")) {
  selftest();
} else {
  const baseArg = process.argv.find((a) => a.startsWith("--base="));
  if (!baseArg) {
    console.error(
      "::error::--base=<ref> is required. Without a base branch there is nothing to compare " +
      "against, and a check that compares against nothing must not report OK.");
    process.exit(1);
  }
  const base = baseArg.slice("--base=".length);

  let addedPaths;
  let basePaths;
  try {
    addedPaths = git(["diff", "--name-only", "--diff-filter=A", base + "...HEAD", "--", MIGRATIONS_DIR])
      .split("\n").filter(Boolean);
    basePaths = git(["ls-tree", "-r", "--name-only", base, MIGRATIONS_DIR])
      .split("\n").filter((p) => p.endsWith(".sql"));
  } catch (err) {
    console.error(
      "::error::could not read the base branch (" + err.message + "). The comparison is " +
      "UNKNOWN, which is red. Check that the workflow fetches " + base + " and not only HEAD.");
    process.exit(1);
  }

  const added = addedPaths.filter((p) => p.endsWith(".sql")).map((p) => p.split("/").pop());
  const baseVersions = basePaths
    .map((p) => extractVersion(p.split("/").pop()))
    .filter((v) => /^[0-9]{14}$/.test(v))
    .sort();
  const baseMax = baseVersions.length ? baseVersions[baseVersions.length - 1] : null;

  const readContents = (name) => git(["show", "HEAD:" + MIGRATIONS_DIR + "/" + name]);
  const { errors, refusals, acknowledged, compared } = verdict(added, baseMax, readContents);

  for (const entry of acknowledged) {
    console.log(
      "  ~ OUT-OF-ORDER, acknowledged: " + entry.name + " (version " + entry.version +
      ") sorts at or below " + baseMax + ": " + entry.reason);
  }

  if (errors.length) {
    for (const message of errors) console.error("  x " + message);
    if (refusals.length) {
      console.error(
        "\nWhy this is refused here rather than after the merge. The apply job orders pending " +
        "migrations by filename within a single run, so a file that merges late while " +
        "numbering early applies after everything numbered above it (OR-T0419). The guard in " +
        ".github/workflows/supabase-deploy.yml catches that, but it runs on a push to dev and " +
        "prod, and it refuses the WHOLE run rather than the one file. Every unrelated change " +
        "queued behind it stops too.");
      console.error(
        "\nTwo ways to clear it. Renumber above " + baseMax + ", or, if applying it late is " +
        "genuinely safe, say so in the file at column one:");
      console.error(
        "\n    -- OUT-OF-ORDER-OK: <a complete reason, on this one line>");
      console.error(
        "\nThe reason is read with `sed ... | head -1`, so the FIRST marker line must stand on " +
        "its own. Put supporting detail on following plain `--` lines that do not repeat the " +
        "token. The reason is for a human reviewer to agree or disagree with, so write what " +
        "makes late application safe for THIS file, not that it is safe.");
    }
    console.error(
      "::error::migration order check failed: " + errors.length + " finding(s). See above.");
    process.exit(1);
  }

  if (compared === 0) {
    console.log(
      "migration order check OK: this pull request adds no migration, so there was nothing to " +
      "order. Nothing was compared and nothing is claimed.");
  } else {
    console.log(
      "migration order check OK: " + compared + " added migration(s) checked against the " +
      "highest version on " + base + " (" + baseMax + "), " + acknowledged.length +
      " acknowledged out-of-order. This says nothing about whether a stated reason is true, " +
      "and nothing about uniqueness (scripts/check-migration-versions.mjs).");
  }
}
