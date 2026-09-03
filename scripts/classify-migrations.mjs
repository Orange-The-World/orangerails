#!/usr/bin/env node
/**
 * classify-migrations.mjs
 *
 * Classify each migration file as REVERSIBLE, IRREVERSIBLE or UNPARSEABLE.
 *
 * WHY THIS EXISTS (OR-T1518, from the ruling on OR-T0537). Our production
 * migration rule says a reversible change is two party between fleet seats and
 * an irreversible one needs the founder. Until this script, nothing in the
 * pipeline could tell the two apart, so the rule was prose: a GRANT and a DROP
 * TABLE took the same path, the same reviewers and the same single click.
 *
 * THE ONE RULE THAT MATTERS. UNPARSEABLE IS IRREVERSIBLE. This script never
 * concludes REVERSIBLE from an absence. If it cannot read a file, cannot find
 * the end of a quote, cannot tell whether a block executes at apply time, or is
 * handed no files at all, it exits non-zero. Every caller must treat ANY
 * non-zero exit as "do not apply", never as "the check did not run".
 *
 * USAGE
 *   node scripts/classify-migrations.mjs FILE [FILE...]
 *   node scripts/classify-migrations.mjs --from-list <path>   one path per line
 *   node scripts/classify-migrations.mjs --selftest           fixtures, both ways
 *   ... [--json <path>]                                       machine readable
 *
 * EXIT CODES
 *   0  every file examined is REVERSIBLE, and at least one file was examined
 *   2  at least one file is IRREVERSIBLE or UNPARSEABLE, or no file was given
 *   1  the classifier itself could not run (bad usage, selftest failure)
 *   Any non-zero exit means DO NOT APPLY.
 *
 * WHAT IT IS NOT. It does not decide whether a change is correct, safe, or
 * wanted. It decides one thing: whether the change has a restore path. A
 * reversible change can still be a bad change; that is what review is for.
 */

import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, 'fixtures', 'migration-classifier');

export const REVERSIBLE = 'REVERSIBLE';
export const IRREVERSIBLE = 'IRREVERSIBLE';
export const UNPARSEABLE = 'UNPARSEABLE';

/**
 * The name in a CREATE [OR REPLACE] FUNCTION|PROCEDURE header, schema qualified
 * or not, quoted identifiers allowed. If this does not match we do not know
 * which routine a body belongs to, so we cannot ask whether the file invokes it,
 * and an unaskable question is a refusal rather than a skip (OR-T1658).
 */
const ROUTINE_NAME =
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+((?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))*)/i;

/** Escape a routine name so it can be dropped into a RegExp as a literal. */
function escapeForRegExp(s) {
  return s.replace(/[^A-Za-z0-9_]/g, (c) => `\\${c}`);
}

/**
 * Statement forms that NAME a routine without causing it to run: its own
 * definition, and the housekeeping around it.
 *
 * Everything else that mentions the routine with an argument list is treated as
 * a possible invocation. That is deliberately generous: over-scanning a body
 * costs an unnecessary refusal that a human can clear in a minute, and
 * under-scanning it costs the data.
 */
function namesWithoutInvoking(flat) {
  return (
    /^CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\b/i.test(flat) ||
    /^(DROP|COMMENT|GRANT|REVOKE)\b/i.test(flat) ||
    /^ALTER\s+(FUNCTION|PROCEDURE|ROUTINE)\b/i.test(flat)
  );
}

/** Does anything in this statement list cause `routine` to run? */
function isInvokedBy(sts, routine) {
  const call = new RegExp(`(^|[^A-Za-z0-9_$])${escapeForRegExp(routine.short)}\\s*\\(`, 'i');
  for (const st of sts) {
    const flat = st.text.replace(/\s+/g, ' ').trim();
    if (!call.test(flat)) continue;
    if (namesWithoutInvoking(flat)) continue;
    return true;
  }
  return false;
}

/** 1-based line number of a character offset in `text`. */
function lineAt(text, offset) {
  return (text.slice(0, offset).match(/\n/g) || []).length + 1;
}

/**
 * Blank out everything that is not executable SQL, character for character, so
 * that offsets into the returned text still map onto the original file and a
 * reported line number is the real line number.
 *
 * Comments and string literals become spaces. Newlines are preserved.
 *
 * Dollar quoted blocks are the interesting case and the reason this is a
 * scanner rather than a regex:
 *
 *   CREATE FUNCTION ... AS $$ ... DROP TABLE t; ... $$;
 *       Whether this body runs at apply time is a property of the WHOLE file,
 *       not of this statement. A migration that creates a routine and then
 *       calls it, or attaches it as a trigger that a later statement fires,
 *       executes the body during the apply. This is a single forward pass, so
 *       the rest of the file has not been read yet and the question cannot be
 *       answered here. The body is set aside with the routine's name and its
 *       offset, and classifySql decides once everything is scrubbed (OR-T1658).
 *       A body whose routine cannot even be NAMED makes the file UNPARSEABLE:
 *       a question that cannot be asked must not be answered with silence.
 *
 *   DO $$ BEGIN ... DROP TABLE t; ... END $$;
 *       The body DOES execute at apply time. Kept, and scanned.
 *
 *   $tag$...$tag$ used anywhere else (a plain string constant)
 *       Dollar quoting is just an alternate way to write a string literal;
 *       CREATE FUNCTION ... AS and DO are the only two forms above that give
 *       it special meaning. Most often this is an ARGUMENT, for example the
 *       scheduled statement passed to cron.schedule(name, schedule, $tag$...
 *       $tag$). It is not routed around (OR-T1705): the contents are scanned
 *       under the exact same rules as ordinary SQL below, because a value
 *       handed to something like cron.schedule keeps running on its own
 *       schedule with nobody reviewing it again, so a TRUNCATE hiding inside
 *       the literal is refused on purpose.
 *
 *   a dollar quote with no closing tag
 *       Genuinely unparseable: the file itself is broken. UNPARSEABLE, which
 *       this script treats as irreversible.
 */
function scrub(sql) {
  const out = [];
  const notes = [];
  const routines = [];
  const n = sql.length;
  let i = 0;

  const blank = (s) => {
    for (const c of s) out.push(c === '\n' ? '\n' : ' ');
  };

  while (i < n) {
    const two = sql.slice(i, i + 2);

    if (two === '--') {
      let j = sql.indexOf('\n', i);
      if (j === -1) j = n;
      blank(sql.slice(i, j));
      i = j;
      continue;
    }

    if (two === '/*') {
      let depth = 0;
      let j = i;
      while (j < n) {
        if (sql.slice(j, j + 2) === '/*') {
          depth += 1;
          j += 2;
          continue;
        }
        if (sql.slice(j, j + 2) === '*/') {
          depth -= 1;
          j += 2;
          if (depth === 0) break;
          continue;
        }
        j += 1;
      }
      if (depth !== 0) {
        return { error: 'unterminated block comment: the end of the file was reached inside /* ... */' };
      }
      blank(sql.slice(i, j));
      i = j;
      continue;
    }

    if (sql[i] === "'") {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) {
        return { error: "unterminated single quoted string literal" };
      }
      blank(sql.slice(i, j));
      i = j;
      continue;
    }

    if (sql[i] === '"') {
      // A quoted identifier is part of the statement, so it is kept, not blanked.
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) {
        return { error: 'unterminated quoted identifier' };
      }
      for (const c of sql.slice(i, j)) out.push(c);
      i = j;
      continue;
    }

    const dq = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dq) {
      const tag = dq[0];
      const close = sql.indexOf(tag, i + tag.length);
      if (close === -1) {
        return { error: `unterminated dollar quoted block opened with ${tag}` };
      }
      const end = close + tag.length;
      const body = sql.slice(i + tag.length, close);
      const produced = out.join('');
      const fragment = produced.slice(produced.lastIndexOf(';') + 1);

      if (/\bCREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\b/i.test(fragment)) {
        // OR-T1658. SET ASIDE, not dismissed. Whether this body runs at apply
        // time depends on the rest of the file, which this pass has not read
        // yet, so record the body with the routine's name and its offset in the
        // original text and let classifySql answer it. Blanked here so that a
        // body which turns out to be unreachable costs nothing, exactly as
        // before.
        const named = ROUTINE_NAME.exec(fragment);
        if (!named) {
          return {
            error:
              'a routine body was found but the routine it defines could not be named from the ' +
              'text, so whether this migration invokes it cannot be answered. An unanswered ' +
              'question takes the irreversible branch, never the silent one',
          };
        }
        const qualified = named[1].replace(/\s+/g, '');
        routines.push({
          name: qualified,
          short: qualified.split('.').pop().replace(/"/g, ''),
          body,
          bodyOffset: i + tag.length,
        });
        blank(sql.slice(i, end));
      } else if (/(^|;)\s*DO\b/i.test(fragment)) {
        blank(tag);
        for (const c of body) out.push(c);
        blank(tag);
      } else {
        // OR-T1705. Syntactically this IS just a string constant (dollar
        // quoting has no other meaning outside the two forms above), most
        // often an argument such as the scheduled statement passed to
        // cron.schedule. A value like that keeps running on its own schedule
        // with nobody reviewing it again, so it is not waved through: its
        // contents are scanned under the same rules as everything else,
        // exactly like a DO block, instead of being refused unread.
        notes.push(
          `dollar quoted block ${tag} is a string literal argument, not a routine body or a ` +
            'DO block: for example the scheduled statement passed to cron.schedule. Its ' +
            'contents were scanned under the same rules as ordinary SQL',
        );
        blank(tag);
        for (const c of body) out.push(c);
        blank(tag);
      }
      i = end;
      continue;
    }

    out.push(sql[i]);
    i += 1;
  }

  return { text: out.join(''), notes, routines };
}

/** Split scrubbed SQL into statements, keeping each one's offset in the file. */
function statements(text) {
  const found = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === ';') {
      found.push({ text: text.slice(start, i), offset: start });
      start = i + 1;
    }
  }
  const tail = text.slice(start);
  if (tail.trim().length > 0) found.push({ text: tail, offset: start });
  return found.filter((s) => s.text.trim().length > 0);
}

/**
 * The irreversible classes. Each one is a change with NO restore path: running
 * it wrong costs the data, not a revert.
 *
 * Several rules are deliberately blunt because the file alone cannot answer the
 * precise question. Those say so in `why`, so the log explains the refusal
 * instead of just asserting it.
 */
const RULES = [
  {
    id: 'DROP TABLE',
    test: (s) => /\bDROP\s+TABLE\b/i.test(s),
    why: 'drops a table and every row in it',
  },
  {
    id: 'DROP SCHEMA',
    test: (s) => /\bDROP\s+SCHEMA\b/i.test(s),
    why: 'drops a schema and everything inside it',
  },
  {
    id: 'DROP DATABASE',
    test: (s) => /\bDROP\s+DATABASE\b/i.test(s),
    why: 'drops a whole database',
  },
  {
    id: 'DROP TYPE',
    test: (s) => /\bDROP\s+TYPE\b/i.test(s),
    why: 'drops a type, and any column still using it goes with it',
  },
  {
    id: 'TRUNCATE',
    // GRANT TRUNCATE and REVOKE TRUNCATE name the privilege, they do not empty
    // anything. A statement that grants or revokes cannot also truncate, so the
    // exclusion cannot hide a real TRUNCATE behind a GRANT.
    test: (s) => /\bTRUNCATE\b/i.test(s) && !/\b(GRANT|REVOKE)\b/i.test(s),
    why: 'empties a table with no restore path',
  },
  {
    id: 'DELETE WITHOUT WHERE',
    test: (s) => /\bDELETE\s+FROM\b/i.test(s) && !/\bWHERE\b/i.test(s),
    why: 'deletes every row in the table: a DELETE with no WHERE clause',
  },
  {
    id: 'DROP INDEX',
    test: (s) => /\bDROP\s+INDEX\b/i.test(s),
    why:
      'the file cannot say whether this index backs a uniqueness guarantee, ' +
      'and dropping one that does silently permits duplicate rows, so the class is refused',
  },
  {
    id: 'ALTER COLUMN TYPE',
    test: (s) =>
      /\bALTER\s+TABLE\b/i.test(s) &&
      /\bALTER\s+(COLUMN\s+)?[^\s,]+\s+(SET\s+DATA\s+)?TYPE\b/i.test(s),
    why:
      'a column type change rewrites the column. Whether it is a widening or a ' +
      'narrowing cannot be answered from the file, because the old type is not in it, ' +
      'so the class is refused rather than guessed',
  },
  {
    id: 'SET NOT NULL',
    test: (s) => /\bALTER\s+TABLE\b/i.test(s) && /\bSET\s+NOT\s+NULL\b/i.test(s),
    why:
      'the file cannot say whether the column is already populated, and on a populated ' +
      'column this either fails the apply or hard codes an assumption about existing rows',
  },
  {
    id: 'ALTER TABLE DROP',
    test: (s) =>
      /\bALTER\s+TABLE\b/i.test(s) &&
      /\bDROP\s+(?!DEFAULT\b|NOT\s+NULL\b|IDENTITY\b|EXPRESSION\b)/i.test(s),
    why:
      'drops a column or a constraint. A dropped column takes its data with it, and a ' +
      'dropped constraint can be backing a uniqueness guarantee',
  },
];

/** Classify one already read SQL string. Returns a verdict plus findings. */
export function classifySql(sql) {
  const scrubbed = scrub(sql);
  if (scrubbed.error) {
    return { verdict: UNPARSEABLE, findings: [{ line: 0, id: 'UNPARSEABLE', why: scrubbed.error, snippet: '' }], notes: [] };
  }

  const sts = statements(scrubbed.text);
  if (sts.length === 0) {
    return {
      verdict: UNPARSEABLE,
      findings: [
        {
          line: 0,
          id: 'NO STATEMENT',
          why:
            'no executable statement was found in this file. An empty migration is either a ' +
            'mistake or a file whose contents this scanner could not see, and neither may be ' +
            'read as REVERSIBLE',
          snippet: '',
        },
      ],
      notes: scrubbed.notes,
    };
  }

  const findings = [];
  const notes = [...scrubbed.notes];

  const applyRules = (flat, line) => {
    for (const rule of RULES) {
      if (rule.test(flat)) {
        findings.push({
          line,
          id: rule.id,
          why: rule.why,
          snippet: flat.length > 160 ? `${flat.slice(0, 160)} ...` : flat,
        });
      }
    }
  };

  for (const st of sts) {
    const lead = st.text.length - st.text.replace(/^\s+/, '').length;
    applyRules(st.text.replace(/\s+/g, ' ').trim(), lineAt(scrubbed.text, st.offset + lead));
  }

  // OR-T1658. A routine body is only harmless if nothing in this same file can
  // make it run. The scrub set each body aside rather than judging it, because a
  // single forward pass cannot see the statements that come after. Now that the
  // whole file is scrubbed, ask the question per routine and, where the answer
  // is yes, scan the body under exactly the rules above.
  //
  // Scanning one body can reveal a call to ANOTHER routine defined in the same
  // file, so this runs to a fixed point rather than once.
  const routines = scrubbed.routines || [];
  const scanned = new Set();
  let reachable = sts;
  let progressed = true;

  while (progressed) {
    progressed = false;
    for (const routine of routines) {
      if (scanned.has(routine)) continue;
      if (!isInvokedBy(reachable, routine)) continue;
      scanned.add(routine);
      progressed = true;

      const inner = scrub(routine.body);
      if (inner.error) {
        return {
          verdict: UNPARSEABLE,
          findings: [
            {
              line: lineAt(sql, routine.bodyOffset),
              id: 'UNPARSEABLE',
              why:
                `this migration invokes ${routine.name}, so its body runs when the migration ` +
                `is applied, and the body could not be read: ${inner.error}`,
              snippet: '',
            },
          ],
          notes,
        };
      }
      if ((inner.routines || []).length > 0) {
        return {
          verdict: UNPARSEABLE,
          findings: [
            {
              line: lineAt(sql, routine.bodyOffset),
              id: 'UNPARSEABLE',
              why:
                `this migration invokes ${routine.name}, and that body itself defines a ` +
                'routine. Whether the inner one runs cannot be answered from the file, so this ' +
                'is refused rather than read as clean',
              snippet: '',
            },
          ],
          notes,
        };
      }

      const bodyLine0 = lineAt(sql, routine.bodyOffset) - 1;
      const innerSts = statements(inner.text);
      for (const st of innerSts) {
        const lead = st.text.length - st.text.replace(/^\s+/, '').length;
        applyRules(
          st.text.replace(/\s+/g, ' ').trim(),
          bodyLine0 + lineAt(inner.text, st.offset + lead),
        );
      }
      reachable = reachable.concat(innerSts);
      notes.push(
        `the body of ${routine.name} was SCANNED: this migration invokes it, so the body runs ` +
          'when the migration is applied',
      );
    }
  }

  for (const routine of routines) {
    if (scanned.has(routine)) continue;
    notes.push(
      `the body of ${routine.name} was not scanned: no statement in this migration calls it, ` +
        'attaches it as a trigger, or otherwise names it with an argument list, so applying ' +
        'this migration does not run it',
    );
  }

  return {
    verdict: findings.length > 0 ? IRREVERSIBLE : REVERSIBLE,
    findings,
    notes,
    statementCount: sts.length,
  };
}

/** Classify one file by path. An unreadable file is UNPARSEABLE, never skipped. */
export function classifyFile(path) {
  let sql;
  try {
    sql = readFileSync(path, 'utf8');
  } catch (err) {
    return {
      file: basename(path),
      path,
      verdict: UNPARSEABLE,
      findings: [{ line: 0, id: 'UNREADABLE', why: `could not read the file: ${err.message}`, snippet: '' }],
      notes: [],
    };
  }
  return { file: basename(path), path, ...classifySql(sql) };
}

function report(results) {
  const counts = { [REVERSIBLE]: 0, [IRREVERSIBLE]: 0, [UNPARSEABLE]: 0 };
  for (const r of results) {
    counts[r.verdict] += 1;
    console.log(`== ${r.file}: ${r.verdict}`);
    for (const note of r.notes || []) console.log(`   note: ${note}`);
    for (const f of r.findings) {
      const where = f.line > 0 ? `line ${f.line}` : 'whole file';
      console.log(`   ${r.verdict}  ${where}  [${f.id}]  ${f.why}`);
      if (f.snippet) console.log(`     ${f.snippet}`);
    }
  }
  console.log('');
  console.log(
    `EXAMINED ${results.length} file(s): ${counts[REVERSIBLE]} REVERSIBLE, ` +
      `${counts[IRREVERSIBLE]} IRREVERSIBLE, ${counts[UNPARSEABLE]} UNPARSEABLE`,
  );
  return counts;
}

/**
 * The self test. A classifier that has never refused anything is
 * indistinguishable from a classifier that CANNOT refuse anything, so this
 * asserts both directions: the reversible fixture must pass and every
 * irreversible and unparseable fixture must be caught, by the named rule.
 */
const EXPECTED = {
  '20990101000001_reversible_everything_allowed.sql': { verdict: REVERSIBLE, id: null },
  '20990101000002_irreversible_drop_table.sql': { verdict: IRREVERSIBLE, id: 'DROP TABLE' },
  '20990101000003_irreversible_drop_column.sql': { verdict: IRREVERSIBLE, id: 'ALTER TABLE DROP' },
  '20990101000004_irreversible_delete_without_where.sql': { verdict: IRREVERSIBLE, id: 'DELETE WITHOUT WHERE' },
  '20990101000005_irreversible_truncate_in_do_block.sql': { verdict: IRREVERSIBLE, id: 'TRUNCATE' },
  '20990101000006_irreversible_alter_column_type.sql': { verdict: IRREVERSIBLE, id: 'ALTER COLUMN TYPE' },
  '20990101000007_irreversible_drop_constraint.sql': { verdict: IRREVERSIBLE, id: 'ALTER TABLE DROP' },
  '20990101000008_unparseable_unterminated_dollar_quote.sql': { verdict: UNPARSEABLE, id: 'UNPARSEABLE' },
  '20990101000009_unparseable_no_statement.sql': { verdict: UNPARSEABLE, id: 'NO STATEMENT' },
  // OR-T1658. A routine body is not inert by virtue of being a routine body.
  // These three assert the difference between one this file calls, one it
  // attaches as a trigger that a later statement fires, and one nothing in the
  // file can reach. The third is the one that keeps the gate usable: it carries
  // a DROP TABLE in its body on purpose, so if the invocation analysis ever
  // starts over-reporting, this fixture goes red instead of the gate quietly
  // starting to refuse ordinary work.
  '20990101000010_irreversible_routine_invoked_in_same_file.sql': { verdict: IRREVERSIBLE, id: 'DROP TABLE' },
  '20990101000011_irreversible_routine_attached_as_trigger.sql': { verdict: IRREVERSIBLE, id: 'TRUNCATE' },
  '20990101000012_reversible_routine_never_invoked.sql': { verdict: REVERSIBLE, id: null },
  // OR-T1705. A dollar quoted block in ARGUMENT position (the cron.schedule
  // pattern) is a plain string constant, not a routine body and not a DO
  // block. These two assert both directions: a scheduled statement that is
  // harmless classifies REVERSIBLE, and one that carries a refused class
  // classifies IRREVERSIBLE naming that rule, instead of either one coming
  // back UNPARSEABLE for the whole file.
  // Numbered 000015 and 000016, not 000013 and 000014: those two ordinals are
  // taken by the OR-T1708 line on srdev-a/or-t1695-quoted-invocation-and-line-
  // assertions, which this line merges with later (OR-T1716).
  '20990101000015_reversible_dollar_quoted_argument.sql': { verdict: REVERSIBLE, id: null },
  '20990101000016_irreversible_dollar_quoted_argument.sql': { verdict: IRREVERSIBLE, id: 'TRUNCATE' },
};

function selftest() {
  if (!existsSync(FIXTURE_DIR)) {
    console.error(`SELFTEST FAILED: fixture directory ${FIXTURE_DIR} does not exist.`);
    return 1;
  }
  const onDisk = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.sql')).sort();
  const expectedNames = Object.keys(EXPECTED).sort();
  let failures = 0;

  if (onDisk.join(',') !== expectedNames.join(',')) {
    console.error('SELFTEST FAILED: the fixture directory and the expectation table disagree.');
    console.error(`  on disk : ${onDisk.join(', ')}`);
    console.error(`  expected: ${expectedNames.join(', ')}`);
    failures += 1;
  }

  for (const name of onDisk) {
    const want = EXPECTED[name];
    if (!want) continue;
    const got = classifyFile(join(FIXTURE_DIR, name));
    const ids = got.findings.map((f) => f.id);
    const verdictOk = got.verdict === want.verdict;
    const ruleOk = want.id === null ? ids.length === 0 : ids.includes(want.id);
    if (verdictOk && ruleOk) {
      console.log(`  ok   ${name}: ${got.verdict}${want.id ? ` [${want.id}]` : ''}`);
    } else {
      failures += 1;
      console.error(
        `  FAIL ${name}: wanted ${want.verdict}${want.id ? ` [${want.id}]` : ' with no finding'}, ` +
          `got ${got.verdict} [${ids.join(', ') || 'no finding'}]`,
      );
    }
  }

  // An empty input list must never be a pass. This is the single most important
  // line in OR-T1518: the classifier may not conclude REVERSIBLE from nothing.
  const emptyRc = run([]);
  if (emptyRc === 0) {
    failures += 1;
    console.error('  FAIL empty input list: the classifier exited 0 on no files at all.');
  } else {
    console.log(`  ok   empty input list is refused (exit ${emptyRc}), not read as clean`);
  }

  if (failures > 0) {
    console.error(`SELFTEST FAILED: ${failures} case(s) wrong. The classifier is not trustworthy; do not apply anything on its word.`);
    return 1;
  }
  console.log('SELFTEST PASSED: the classifier fires on every irreversible and unparseable fixture, and is silent on the reversible one.');
  return 0;
}

/** Classify a list of paths and report. Returns the process exit code. */
function run(paths, jsonPath) {
  if (paths.length === 0) {
    console.error(
      '::error::classify-migrations was given NO files. Refusing to conclude REVERSIBLE ' +
        'from an empty list: an empty list means the caller could not work out what would ' +
        'be applied, which is not the same fact as nothing being applied.',
    );
    return 2;
  }
  const results = paths.map(classifyFile);
  const counts = report(results);
  if (jsonPath) {
    writeFileSync(
      jsonPath,
      `${JSON.stringify(
        {
          examined: results.length,
          reversible: counts[REVERSIBLE],
          irreversible: counts[IRREVERSIBLE],
          unparseable: counts[UNPARSEABLE],
          files: results.map((r) => ({ file: r.file, verdict: r.verdict, findings: r.findings })),
        },
        null,
        2,
      )}\n`,
    );
  }
  return counts[IRREVERSIBLE] > 0 || counts[UNPARSEABLE] > 0 ? 2 : 0;
}

function main(argv) {
  const args = [...argv];
  let jsonPath = null;
  let fromList = null;
  const paths = [];

  while (args.length > 0) {
    const a = args.shift();
    if (a === '--selftest') return selftest();
    if (a === '--json') {
      jsonPath = args.shift();
      if (!jsonPath) {
        console.error('usage: --json <path>');
        return 1;
      }
      continue;
    }
    if (a === '--from-list') {
      fromList = args.shift();
      if (!fromList) {
        console.error('usage: --from-list <path>');
        return 1;
      }
      continue;
    }
    if (a.startsWith('--')) {
      console.error(`unknown option ${a}`);
      return 1;
    }
    paths.push(a);
  }

  if (fromList) {
    if (!existsSync(fromList)) {
      console.error(
        `::error::classify-migrations could not read the file list ${fromList}. ` +
          'The set of migrations this run would apply is UNKNOWN, so nothing may be applied.',
      );
      return 2;
    }
    for (const line of readFileSync(fromList, 'utf8').split('\n')) {
      const t = line.trim();
      if (t) paths.push(t);
    }
  }

  return run(paths, jsonPath);
}

process.exit(main(process.argv.slice(2)));
