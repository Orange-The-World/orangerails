#!/usr/bin/env node
/**
 * Create a new Supabase migration file, with the version taken from the real
 * UTC clock to the second.
 *
 * WHY THIS EXISTS
 *
 * Migration versions in this repo were typed by hand and typed rounded to the
 * hour. `supabase_migrations.schema_migrations` holds exactly ONE row per
 * version, so two files sharing a version prefix is not a cosmetic clash: the
 * first file to be recorded makes the second one look already applied, and the
 * second is skipped silently, on every cluster, forever. The symptom arrives
 * much later, as an object that does not exist on a database the ledger says
 * is current.
 *
 * The version field is fourteen digits and already carries seconds. Taking it
 * from the clock instead of from a person removes the collision at the source.
 *
 * USAGE
 *
 *   npm run migration:new -- add_widget_table
 *       creates supabase/migrations/<version>_add_widget_table.sql and prints
 *       the path.
 *
 *   npm run migration:new -- --version-only
 *       prints just the fourteen digit version and writes nothing. Use this
 *       when you want to name the file yourself.
 *
 * FORMAT CONTRACT, do not break these
 *
 *   - Fourteen digits, YYYYMMDDHHMMSS, UTC, zero padded, fixed width. Fixed
 *     width is what makes a lexical sort equal a chronological sort.
 *   - Everything before the FIRST underscore is the version. The deploy
 *     workflow parses it with `cut -d_ -f1`, so the version must never contain
 *     an underscore.
 *   - The version must sort strictly above every version already in the tree,
 *     because migrations apply in order.
 */

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = "supabase/migrations";

/** A well formed version: exactly fourteen digits. */
const VERSION_RE = /^\d{14}$/;

/** lower_snake_case, no leading or trailing underscore, no double underscore. */
const SLUG_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

/**
 * The version for an instant, in UTC, to the second.
 * Every component is zero padded so the result is always fourteen characters,
 * which is what keeps a lexical sort chronological.
 */
function versionFor(date) {
  const pad = (value, width) => String(value).padStart(width, "0");
  return (
    pad(date.getUTCFullYear(), 4) +
    pad(date.getUTCMonth() + 1, 2) +
    pad(date.getUTCDate(), 2) +
    pad(date.getUTCHours(), 2) +
    pad(date.getUTCMinutes(), 2) +
    pad(date.getUTCSeconds(), 2)
  );
}

/** Every migration filename in the tree, or an empty list if there is no dir. */
function migrationFiles() {
  if (!existsSync(MIG_DIR)) return [];
  return readdirSync(MIG_DIR).filter((name) => name.endsWith(".sql"));
}

/**
 * The version prefix of a filename: everything before the first underscore.
 * This deliberately mirrors `cut -d_ -f1` in the deploy workflow. If the two
 * ever disagree, this script is wrong and the workflow is right, because the
 * workflow is what actually decides whether a file is applied.
 */
function versionOf(filename) {
  return filename.split("_")[0];
}

function fail(message) {
  console.error(`new-migration: ${message}`);
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2).filter((arg) => arg.length > 0);
  const versionOnly = args.includes("--version-only");
  const positional = args.filter((arg) => !arg.startsWith("--"));

  const version = versionFor(new Date());

  // Should be unreachable, but this is the one invariant everything else
  // rests on, so it is checked rather than trusted.
  if (!VERSION_RE.test(version)) {
    fail(`generated version ${version} is not fourteen digits, refusing to continue`);
  }

  const files = migrationFiles();

  // 1. Collision. Another file already claims this exact version.
  //    Only reachable if a hand-typed file happens to sit on this second.
  const collision = files.filter((name) => versionOf(name) === version);
  if (collision.length > 0) {
    fail(
      `version ${version} is already used by ${collision.join(", ")}. ` +
        `Wait one second and run again.`,
    );
  }

  // 2. Ordering. Migrations apply in order, so a new file must sort above
  //    everything already present. A hand-typed version set in the future
  //    (we have shipped at least one, and one with an hour of 24) would
  //    otherwise let this script emit a version that applies too early.
  //    All versions are fixed width, so a string compare is a time compare.
  const known = files.map(versionOf).filter((value) => VERSION_RE.test(value));
  const highest = known.length > 0 ? known.reduce((a, b) => (a > b ? a : b)) : null;
  if (highest !== null && version <= highest) {
    const owner = files.find((name) => versionOf(name) === highest);
    fail(
      `the clock says ${version}, but ${owner} already claims the higher version ${highest}. ` +
        `A new migration must sort above every existing one because they apply in order. ` +
        `That file is dated in the future: correct its version, or wait until the clock passes it.`,
    );
  }

  if (versionOnly) {
    console.log(version);
    return;
  }

  const slug = positional[0];
  if (!slug) {
    fail(
      "give the migration a name, for example: npm run migration:new -- add_widget_table " +
        "(or pass --version-only to just print a version)",
    );
  }
  if (!SLUG_RE.test(slug)) {
    fail(
      `"${slug}" is not a usable name. Use lower_snake_case: letters, digits and ` +
        `single underscores, no leading or trailing underscore.`,
    );
  }

  const filename = `${version}_${slug}.sql`;
  const path = join(MIG_DIR, filename);

  // Belt and braces: the version must survive the workflow's own parse.
  if (versionOf(filename) !== version) {
    fail(`refusing to write ${filename}: its version does not parse back to ${version}`);
  }
  if (existsSync(path)) {
    fail(`${path} already exists, refusing to overwrite it`);
  }

  writeFileSync(
    path,
    `-- ============================================================
-- ${slug.replace(/_/g, " ")}
-- ============================================================
-- Ticket:
--
-- WHY
--   What problem this solves, and why now.
--
-- WHAT CHANGES
--   The change itself, in plain terms.
--
-- IDEMPOTENT
--   Say whether a re-run is a no-op, and what makes it so.
--
-- REVERSIBLE
--   How to undo this, or why it cannot be undone. If it cannot be
--   undone, say so plainly here: that is what makes it founder gated.
-- ============================================================

BEGIN;

-- your change here

COMMIT;
`,
    { encoding: "utf8", flag: "wx" },
  );

  console.log(path);
}

main();
