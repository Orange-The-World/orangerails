// Drift check: the sink format slugs registered in dispatch.ts (the code
// side) must equal, in BOTH directions, the set of values the Postgres CHECK
// constraint platforms_sink_format_registered admits (the schema side).
// See OR-T1215 / OR-T1230 for the full analysis this implements.
//
// DO NOT regex dispatch.ts for slugs. SINK_ADAPTERS is keyed by expressions
// (bitbooksV2Sink.format), not string literals -- the slugs live in each
// adapter's own file (e.g. 'bitbooks-v2' in bitbooks-v2.ts). A regex over
// dispatch.ts finds zero slugs, and zero compared against zero reads as
// equal, which is the exact silent-success defect this test exists to catch.
// Import the module and call listSinkFormats() instead: it is the same
// function or-sync trusts at runtime, so it is immune to the literal problem.

import {
  assert,
  assertEquals,
  assertRejects,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { listSinkFormats } from './dispatch.ts';

const CONSTRAINT_NAME = 'platforms_sink_format_registered';

/**
 * Parse the value set a CHECK constraint named CONSTRAINT_NAME admits, from
 * the LAST migration (by filename/version order) that defines it.
 *
 * Migration filenames are version-prefixed (YYYYMMDDHHMMSS_name.sql), so a
 * lexical sort of the directory listing is version order.
 *
 * Anchors the regex on the constraint NAME and its value list TOGETHER, in
 * one match. A pattern that matched the name alone would return a match with
 * an empty value list -- indistinguishable from "the constraint admits
 * nothing", which is the same empty-equals-empty trap as the code side.
 *
 * Never returns an empty or undefined result silently. Throws when: the
 * migrations directory cannot be read, no migration in it defines the
 * constraint at all, or a migration defines it but the parsed value list is
 * empty. "I could not check" must be loud, not a quiet pass.
 */
async function admittedSlugsFromMigrations(migrationsDir: URL): Promise<string[]> {
  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(migrationsDir)) {
      entries.push(entry);
    }
  } catch (err) {
    throw new Error(
      `admittedSlugsFromMigrations: could not read migrations directory ${migrationsDir}: ${err}`,
    );
  }

  const files = entries
    .filter((e) => e.isFile && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort();

  if (files.length === 0) {
    throw new Error(`admittedSlugsFromMigrations: no .sql files found under ${migrationsDir}`);
  }

  // The rendered/authored definition may spell the value list as either
  // `IN ('a', 'b')` (as authored) or `= ANY (ARRAY['a'::text, 'b'::text])`
  // (as some Postgres versions render it back via pg_get_constraintdef). Only
  // the constraint name plus a CHECK(...) block anchored together counts as a
  // match; quoted literals are then pulled out of that block only, never from
  // the whole file, so comments and unrelated strings elsewhere in the
  // migration cannot leak into the admitted set.
  const pattern = new RegExp(`ADD CONSTRAINT\\s+${CONSTRAINT_NAME}\\s+CHECK\\s*\\(([^;]*)\\)\\s*;`);

  let lastMatchSlugs: string[] | null = null;
  let lastMatchFile = '';

  for (const name of files) {
    const text = await Deno.readTextFile(new URL(name, migrationsDir));
    const m = text.match(pattern);
    if (!m) continue;
    const body = m[1];
    const literals = Array.from(body.matchAll(/'([^']*)'/g)).map((mm) => mm[1]);
    // Keep scanning: a LATER migration in version order must override an
    // earlier one (the drop-and-recreate case), never the reverse.
    lastMatchSlugs = literals;
    lastMatchFile = name;
  }

  if (lastMatchSlugs === null) {
    throw new Error(
      `admittedSlugsFromMigrations: no migration under ${migrationsDir} defines CHECK constraint ${CONSTRAINT_NAME}`,
    );
  }
  if (lastMatchSlugs.length === 0) {
    throw new Error(
      `admittedSlugsFromMigrations: migration ${lastMatchFile} defines ${CONSTRAINT_NAME} but its value list parsed empty`,
    );
  }
  return lastMatchSlugs;
}

// From supabase/functions/_shared/sinks/, the migrations directory is
// ../../../migrations/ (sinks -> _shared -> functions -> supabase/migrations).
// Resolved via import.meta.url so it is correct regardless of the process cwd
// the test runner happens to use.
const REAL_MIGRATIONS_DIR = new URL('../../../migrations/', import.meta.url);

Deno.test('sink_format drift: dispatch.ts registers exactly what the DB constraint admits', async () => {
  const codeSlugs = listSinkFormats();
  assert(
    codeSlugs.length > 0,
    'listSinkFormats() returned zero slugs -- the code side resolved to nothing, cannot compare',
  );

  const dbSlugs = await admittedSlugsFromMigrations(REAL_MIGRATIONS_DIR);

  const codeSet = Array.from(new Set(codeSlugs)).sort();
  const dbSet = Array.from(new Set(dbSlugs)).sort();

  // Named counts and both sets, so a run that compared nothing cannot read as
  // green from its own output.
  console.log(
    `dispatch.ts registers ${codeSet.length} [${codeSet.join(', ')}]; ` +
      `constraint admits ${dbSet.length} [${dbSet.join(', ')}]; ` +
      `${codeSet.join(',') === dbSet.join(',') ? 'equal' : 'NOT EQUAL'}`,
  );

  assertEquals(
    codeSet,
    dbSet,
    'sink format slugs registered in dispatch.ts and the value list platforms_sink_format_registered admits have drifted apart',
  );
});

Deno.test('sink_format drift: a migrations path with no such directory is a hard failure, not a pass', async () => {
  const bogus = new URL('./this-directory-does-not-exist-OR-T1230/', import.meta.url);
  await assertRejects(() => admittedSlugsFromMigrations(bogus), Error);
});
