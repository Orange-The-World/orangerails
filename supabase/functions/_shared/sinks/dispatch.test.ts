// Drift check for OR-T1230 (spec: OR-T1215, out of OR-T1200): the sink
// format slugs registered in dispatch.ts must equal, in BOTH directions, the
// slugs the platforms_sink_format_registered CHECK constraint admits.
//
// THE ASYMMETRY THIS GUARDS AGAINST. An adapter registered in dispatch.ts but
// not admitted by the constraint refuses a legitimate write loudly, at
// onboarding time -- noisy, and it gets found. An adapter removed from the
// map while its slug is still admitted leaves the column accepting a value
// that resolves to no adapter -- quiet, and it 400s a live customer sync once
// OR_SYNC_SINK_FORMAT_ENFORCE is on. That second direction is the one this
// check exists for, so this is an equality test both ways, never a subset
// test in either direction.
//
// DO NOT PARSE dispatch.ts FOR QUOTED SLUGS. SINK_ADAPTERS is keyed by
// EXPRESSIONS, not string literals:
//   [bitbooksV2Sink.format, bitbooksV2Sink],
//   [orangewayMeSink.format, orangewayMeSink],
// The slug strings live in each sink's own file. A regex over dispatch.ts
// for quoted strings finds ZERO, and zero compared against zero reads as
// equal -- the exact silent-success defect this check exists to prevent.
// listSinkFormats() is called instead: it already returns exactly the
// registered slugs, and it is the same function or-sync trusts at runtime.

import { listSinkFormats } from './dispatch.ts';

const CONSTRAINT_NAME = 'platforms_sink_format_registered';
const MIGRATIONS_DIR = new URL('../../../migrations-does-not-exist-or-t1230-mutation-iii/', import.meta.url);

interface ParsedConstraint {
  file: string;
  values: string[];
}

/**
 * Find the migration that most recently (re)defines platforms_sink_format_registered
 * and parse the admitted value list out of its CHECK clause.
 *
 * Migration filenames are a leading timestamp, so a lexicographic sort of
 * filenames is a version-order sort. We scan from the NEWEST file backward
 * and take the first one that both names the constraint and defines it with
 * an ADD CONSTRAINT ... CHECK -- never the first match overall. Adding a
 * third adapter means dropping and recreating this constraint, so a
 * first-match (oldest-first) parse would pin a superseded definition and go
 * quietly blind exactly when a new adapter ships.
 *
 * The regex anchors the constraint NAME and its value list TOGETHER. A
 * pattern matching the name alone (for example a DROP CONSTRAINT line, or a
 * comment mentioning the name) would return a match with an empty value
 * list, which is the same empty-equals-empty trap from the other direction.
 */
async function findRegisteredSlugs(): Promise<ParsedConstraint | null> {
  const candidates: string[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (entry.isFile && entry.name.endsWith('.sql')) {
      candidates.push(entry.name);
    }
  }
  candidates.sort();

  const addConstraintCheck = new RegExp(
    `ADD CONSTRAINT\\s+${CONSTRAINT_NAME}\\s+CHECK\\s*\\(([^;]*)\\)\\s*;`,
    'is',
  );

  for (let i = candidates.length - 1; i >= 0; i--) {
    const file = candidates[i];
    const text = await Deno.readTextFile(new URL(file, MIGRATIONS_DIR));
    if (!text.includes(CONSTRAINT_NAME)) continue;
    const match = addConstraintCheck.exec(text);
    if (!match) continue;
    const clause = match[1];
    const values = Array.from(clause.matchAll(/'([^']+)'/g)).map((m) => m[1]);
    return { file, values };
  }
  return null;
}

Deno.test(
  'sink_format: dispatch.ts registrations equal what platforms_sink_format_registered admits',
  async () => {
    const codeSlugs = listSinkFormats();
    if (codeSlugs.length === 0) {
      throw new Error(
        'sink_format drift check: listSinkFormats() returned zero slugs. Refusing to ' +
          'compare against an empty set -- that is a broken check, not a passing one.',
      );
    }

    const parsed = await findRegisteredSlugs();
    if (parsed === null) {
      throw new Error(
        `sink_format drift check: no migration under supabase/migrations/ defines ` +
          `CHECK CONSTRAINT ${CONSTRAINT_NAME} via ADD CONSTRAINT ... CHECK. A check ` +
          'that compared nothing must not read as green.',
      );
    }
    if (parsed.values.length === 0) {
      throw new Error(
        `sink_format drift check: found ${CONSTRAINT_NAME} in ${parsed.file} but parsed ` +
          'zero admitted values out of its CHECK clause. Refusing to compare against an ' +
          'empty set.',
      );
    }

    const codeSet = new Set(codeSlugs);
    const dbSet = new Set(parsed.values);
    const sortedCode = [...codeSet].sort();
    const sortedDb = [...dbSet].sort();

    const onlyInCode = sortedCode.filter((s) => !dbSet.has(s));
    const onlyInDb = sortedDb.filter((s) => !codeSet.has(s));

    const summary =
      `dispatch.ts registers ${codeSet.size} [${sortedCode.join(', ')}]; ` +
      `${parsed.file} admits ${dbSet.size} [${sortedDb.join(', ')}]`;

    if (onlyInCode.length > 0 || onlyInDb.length > 0) {
      const lines = [summary + '; DRIFT DETECTED'];
      if (onlyInCode.length > 0) {
        lines.push(
          '  registered in dispatch.ts but NOT admitted by the constraint (refuses a ' +
            `legitimate write at onboarding time): ${onlyInCode.join(', ')}`,
        );
      }
      if (onlyInDb.length > 0) {
        lines.push(
          '  admitted by the constraint but NOT registered in dispatch.ts (accepts a ' +
            `value that resolves to no adapter, 400s a live sync): ${onlyInDb.join(', ')}`,
        );
      }
      throw new Error(lines.join('\n'));
    }

    console.log(`${summary}; equal`);
  },
);
