#!/usr/bin/env node
/**
 * Prints the filename for a new migration, with the version taken from the real
 * UTC clock to the second.
 *
 * Why this exists rather than a sentence in a document telling people to use
 * `date -u`. Every migration version in this repo was typed by hand and typed
 * rounded: of 60 distinct versions referenced since 2026-08-20, 45 landed on an
 * exact hour, not one carried a real seconds value, two were manual "plus one
 * second" dodges of an earlier collision, and one was hour 24, which is not a
 * time that exists. A convention nobody invokes is how that happened, so this is
 * something you run.
 *
 * Why a duplicate version is expensive rather than untidy.
 * supabase_migrations.schema_migrations holds one row per version, so the second
 * file to arrive is recorded as already applied and is silently skipped. It does
 * not fail at apply time. It surfaces much later as an object that does not
 * exist on a cluster whose ledger says it is current.
 *
 * Two constraints this must not break, and does not:
 *   - the version stays a fixed width, left-padded, lexically sortable 14 digit
 *     string, because out-of-order apply guards depend on that ordering
 *   - everything before the FIRST underscore is the version, because the deploy
 *     check parses it with `ls | cut -d_ -f1`
 *
 * Usage:
 *   npm run db:new                          prints just the version
 *   npm run db:new -- add_widget_table      prints the full path, creates nothing
 *   npm run db:new -- add_widget_table --write   also writes the file with a header stub
 */

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");

/** A migration slug: lowercase, starts with a letter, underscores between words. */
const SLUG = /^[a-z][a-z0-9_]*$/;

function pad(n, width) {
  return String(n).padStart(width, "0");
}

/** The 14 digit version for a moment, in UTC. Fixed width, so it sorts lexically. */
function versionFor(date) {
  return (
    pad(date.getUTCFullYear(), 4) +
    pad(date.getUTCMonth() + 1, 2) +
    pad(date.getUTCDate(), 2) +
    pad(date.getUTCHours(), 2) +
    pad(date.getUTCMinutes(), 2) +
    pad(date.getUTCSeconds(), 2)
  );
}

/**
 * Versions already present in the tree. Read with the same rule the deploy check
 * uses, everything before the first underscore, so this cannot disagree with it.
 */
function takenVersions() {
  if (!existsSync(MIGRATIONS_DIR)) return new Set();
  return new Set(
    readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.split("_")[0]),
  );
}

/**
 * The clock's version, or the next free second after it. Walking forward is what
 * removes the reason anyone ever typed a manual "plus one second" by hand.
 */
function nextFreeVersion(now) {
  const taken = takenVersions();
  const at = new Date(now.getTime());
  let version = versionFor(at);
  let moved = 0;

  while (taken.has(version)) {
    at.setUTCSeconds(at.getUTCSeconds() + 1);
    version = versionFor(at);
    moved += 1;
    if (moved > 3600) {
      throw new Error(
        "every version for the next hour is already taken, which is not a real state. Look at supabase/migrations before going further.",
      );
    }
  }

  return { version, moved };
}

function stubFor(version, slug) {
  return `-- ${version}_${slug}.sql
--
-- WHAT THIS CHANGES:
-- WHY NOW:
-- CAN IT BE UNDONE: state the undo, or say plainly that there is none and why.
-- IS IT IDEMPOTENT: IF NOT EXISTS / IF EXISTS guards, so a re-run never doubles
--   anything and never wedges.
--
-- The version above came from the UTC clock via scripts/new-migration.mjs. Do not
-- hand-edit it to a rounder number. A duplicate version is recorded as already
-- applied and the second file is then silently skipped.

BEGIN;

-- the change goes here

COMMIT;
`;
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const slug = args.find((arg) => !arg.startsWith("--"));

  if (slug !== undefined && !SLUG.test(slug)) {
    console.error(
      `refused: "${slug}" is not a usable migration slug. Use lowercase letters, digits and underscores, starting with a letter, for example add_widget_table.`,
    );
    process.exit(1);
  }

  const { version, moved } = nextFreeVersion(new Date());
  if (moved > 0) {
    console.error(
      `note: ${moved} second(s) from now were already used by an existing migration, so this is ${version}.`,
    );
  }

  if (slug === undefined) {
    console.log(version);
    return;
  }

  const filename = `${version}_${slug}.sql`;
  const full = path.join(MIGRATIONS_DIR, filename);

  if (write) {
    if (existsSync(full)) {
      console.error(`refused: ${filename} already exists.`);
      process.exit(1);
    }
    writeFileSync(full, stubFor(version, slug), { flag: "wx" });
    console.error(`created supabase/migrations/${filename}`);
  }

  console.log(`supabase/migrations/${filename}`);
}

main();
