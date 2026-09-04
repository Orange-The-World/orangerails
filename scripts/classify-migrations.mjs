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
 * THE SAME RULE APPLIED TO DYNAMIC SQL. A DO block that runs at apply time can
 * assemble a statement at run time and hand it to EXECUTE. When the text being
 * executed comes from a variable, the file does not say what will run, so the
 * absence of a DROP in the file is not evidence that no DROP happens. That is
 * refused (DYNAMIC EXECUTE). An EXECUTE whose statement IS written out in the
 * file, as a literal or as format() with a literal template using only %I and
 * %L, is read normally: those quote what they interpolate and cannot introduce
 * a statement, so the rules below see the real SQL and judge it on its merits.
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
 *       The body does NOT execute when the migration is applied. It executes
 *       when somebody later calls the function. Blanked, and noted.
 *
 *   DO $$ BEGIN ... DROP TABLE t; ... END $$;
 *       The body DOES execute at apply time, so it is scanned. It goes through
 *       scrubDoBody rather than through this function, because the two want
 *       opposite things from a string literal. See that function's own comment:
 *       the difference is deliberate and it is load bearing.
 *
 *   anything else, or a dollar quote with no closing tag
 *       We cannot say which of the two it is, so it is UNPARSEABLE, which this
 *       script treats as irreversible.
 */
function scrub(sql) {
  const out = [];
  const notes = [];
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
        notes.push('a routine body was skipped: it does not execute when the migration is applied');
        blank(sql.slice(i, end));
      } else if (/(^|;)\s*DO\b/i.test(fragment)) {
        // OR-T1709. The body executes at apply time, so it is scanned. It is
        // scanned by scrubDoBody and NOT by this function: a comment inside a
        // DO body is not executable SQL and must be blanked like any other
        // comment, while a string literal inside a DO body usually IS the
        // statement EXECUTE is about to run and must be kept. This copied the
        // body through character for character, which left comments in the
        // scanned text and let one of them supply the token that exempts the
        // next EXECUTE from the dynamic-SQL check.
        const inner = scrubDoBody(body);
        if (inner.error) {
          return { error: `a DO block body could not be read: ${inner.error}` };
        }
        blank(tag);
        for (const c of inner.text) out.push(c);
        blank(tag);
      } else {
        return {
          error:
            `dollar quoted block ${tag} is neither a routine body nor a DO block, ` +
            'so whether its contents execute at apply time cannot be determined from the file',
        };
      }
      i = end;
      continue;
    }

    out.push(sql[i]);
    i += 1;
  }

  return { text: out.join(''), notes };
}

/**
 * Scrub the body of a DO block. This is a DIFFERENT scrub from the one above,
 * on purpose, and the difference is the whole point of OR-T1709.
 *
 * A DO body executes when the migration is applied, so it has to be scanned.
 * But it is also the one place in a migration where a string literal is usually
 * not data: it is the statement EXECUTE is about to run, and it is the only
 * readable copy of that statement anywhere in the file. The two scrubs
 * therefore want opposite things:
 *
 *   comments            BLANKED. A comment never executes, here or anywhere.
 *                       Leaving them in let a comment be read as code in both
 *                       directions. Prose mentioning DROP TABLE refused a clean
 *                       file, and a comment whose last word was GRANT or REVOKE
 *                       satisfied the exemption in executeIsUnreadable for the
 *                       EXECUTE on the next line, because that anchor ends in
 *                       \s and \s matches a newline.
 *
 *   string literals     KEPT, character for character, because they carry the
 *                       dynamic SQL. Blanking them would flatten
 *                       EXECUTE 'drop table t' to EXECUTE, no rule would match,
 *                       and the file would read as clean while it drops a table.
 *                       Only a semicolon INSIDE a literal is blanked, so a
 *                       literal cannot split a statement it merely mentions.
 *
 *   quoted identifiers  Kept, same as at the top level, semicolons aside.
 *
 *   dollar quoted text  Treated as another way of writing a literal: kept, with
 *                       its semicolons blanked. An unterminated one is an error,
 *                       never silence.
 *
 * THE TRADE, stated rather than hidden. A literal that really is prose, such as
 * a RAISE NOTICE explaining why nothing was truncated, is now scanned as if it
 * were SQL and can refuse a file that is perfectly fine. That is the safe
 * direction and it is accepted deliberately. The opposite trade lets a real
 * DROP through, and this script never concludes REVERSIBLE from an absence.
 *
 * Length preserving on every branch: one character out for every character in,
 * newlines kept as newlines. That is what lets the caller fold the result back
 * at the same offset and still report real line numbers.
 */
function scrubDoBody(sql) {
  const out = [];
  const n = sql.length;
  let i = 0;

  const blank = (s) => {
    for (const c of s) out.push(c === '\n' ? '\n' : ' ');
  };

  // Kept as written, except that a semicolon inside it must not be able to end
  // a statement: the text is quoted, so the semicolon is content, not a
  // separator.
  const keepButNeverSplit = (s) => {
    for (const c of s) out.push(c === ';' ? ' ' : c);
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
        return { error: 'unterminated block comment inside a DO block body' };
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
        return { error: 'unterminated single quoted string literal inside a DO block body' };
      }
      keepButNeverSplit(sql.slice(i, j));
      i = j;
      continue;
    }

    if (sql[i] === '"') {
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
        return { error: 'unterminated quoted identifier inside a DO block body' };
      }
      keepButNeverSplit(sql.slice(i, j));
      i = j;
      continue;
    }

    const dq = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dq) {
      const tag = dq[0];
      const close = sql.indexOf(tag, i + tag.length);
      if (close === -1) {
        return {
          error: `unterminated dollar quoted block opened with ${tag} inside a DO block body`,
        };
      }
      keepButNeverSplit(sql.slice(i, close + tag.length));
      i = close + tag.length;
      continue;
    }

    out.push(sql[i]);
    i += 1;
  }

  return { text: out.join('') };
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
 * Index just past the closing quote of the single quoted literal starting at i,
 * or -1 if the literal is never closed. Callers treat -1 as unreadable rather
 * than skipping it, so a malformed quote can never widen what is allowed.
 */
function endOfLiteral(text, i) {
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === "'") {
      if (text[j + 1] === "'") {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j += 1;
  }
  return -1;
}

/** Split on a separator that is not inside a literal and not inside parentheses. */
function splitTop(text, sep) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      const end = endOfLiteral(text, i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (c === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === ')') {
      if (depth > 0) depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0 && text.startsWith(sep, i)) {
      parts.push(text.slice(start, i));
      i += sep.length;
      start = i;
      continue;
    }
    i += 1;
  }
  parts.push(text.slice(start));
  return parts;
}

/** The EXECUTE argument itself: everything up to a top level USING or INTO. */
function executeArgument(after) {
  let depth = 0;
  let i = 0;
  while (i < after.length) {
    const c = after[i];
    if (c === "'") {
      const end = endOfLiteral(after, i);
      i = end === -1 ? after.length : end;
      continue;
    }
    if (c === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === ')') {
      if (depth === 0) break;
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0 && /\s/.test(c) && /^\s+(USING|INTO)\b/i.test(after.slice(i))) break;
    i += 1;
  }
  return after.slice(0, i);
}

/**
 * Is one piece of an EXECUTE argument readable from the file?
 *
 * Readable means the SQL text is HERE, so the rules below can judge it:
 *   'DROP TABLE t'                       a literal, read as written
 *   format('CREATE INDEX %I ON t (a)', x) a literal template. %I and %L quote
 *                                        what they interpolate, so an argument
 *                                        cannot smuggle in a statement. %s
 *                                        splices raw text and is NOT readable.
 *   quote_ident(x)                       emits one quoted token, never a
 *                                        statement
 * Anything else, a bare variable most of all, is not readable: the statement
 * that will run is decided at run time and is not in this file.
 */
function readablePiece(piece) {
  const p = piece.trim();
  if (p === '') return false;
  if (p.startsWith("'")) return endOfLiteral(p, 0) === p.length;
  if (/^(quote_ident|quote_literal|quote_nullable)\s*\([\s\S]*\)$/i.test(p)) return true;
  const fmt = /^format\s*\(([\s\S]*)\)$/i.exec(p);
  if (!fmt) return false;
  const template = splitTop(fmt[1], ',')[0] ?? '';
  if (!splitTop(template, '||').every(readablePiece)) return false;
  return !/%(?![ILil%])/.test(template);
}

/**
 * True when this statement runs SQL that cannot be read from the file.
 *
 * GRANT EXECUTE and REVOKE EXECUTE name a privilege on a function. They run
 * nothing, so they are excluded: a gate that refuses every GRANT would fire on
 * ordinary work and be routed around within a month.
 *
 * The exemption is anchored to the token IMMEDIATELY before EXECUTE, and that
 * anchoring is the control, not a detail of it. Testing the whole prefix of the
 * statement instead means one occurrence of the word GRANT or REVOKE anywhere
 * earlier, in a comment as easily as in code, switches this check off for every
 * EXECUTE after it. Comments in this repo's security migrations say REVOKE
 * constantly, so that is reachable with ordinary text, and it fails in the
 * direction that costs data: REVERSIBLE on a file that drops a table at apply
 * time.
 */
function executeIsUnreadable(flat) {
  const re = /\bEXECUTE\b/gi;
  let m = re.exec(flat);
  while (m !== null) {
    if (!/\b(GRANT|REVOKE)\s+$/i.test(flat.slice(0, m.index))) {
      const arg = executeArgument(flat.slice(m.index + 'EXECUTE'.length));
      if (!splitTop(arg, '||').every(readablePiece)) return true;
    }
    m = re.exec(flat);
  }
  return false;
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
  {
    id: 'DYNAMIC EXECUTE',
    test: (s) => executeIsUnreadable(s),
    why:
      'runs SQL that is assembled at run time. The statement it will execute is not in ' +
      'this file, so whether it drops anything cannot be read here, and an absence of ' +
      'findings is not evidence of safety. Write the statement out, or apply it under an ' +
      'explicit authority',
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
  for (const st of sts) {
    const lead = st.text.length - st.text.replace(/^\s+/, '').length;
    const absolute = st.offset + lead;
    const line = (scrubbed.text.slice(0, absolute).match(/\n/g) || []).length + 1;
    const flat = st.text.replace(/\s+/g, ' ').trim();
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
  }

  return {
    verdict: findings.length > 0 ? IRREVERSIBLE : REVERSIBLE,
    findings,
    notes: scrubbed.notes,
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
  '20990101000010_irreversible_dynamic_execute.sql': { verdict: IRREVERSIBLE, id: 'DYNAMIC EXECUTE' },
  '20990101000011_reversible_dynamic_execute_format.sql': { verdict: REVERSIBLE, id: null },
  '20990101000012_irreversible_execute_format_drop_constraint.sql': {
    verdict: IRREVERSIBLE,
    id: 'ALTER TABLE DROP',
  },
  // The word revoke appears only in a comment in this one, and the verb is
  // built by concatenation so no static rule can match it. It classified
  // REVERSIBLE while the GRANT and REVOKE exemption tested the whole statement
  // prefix instead of the token immediately before EXECUTE.
  '20990101000015_irreversible_dynamic_execute_after_revoke_comment.sql': {
    verdict: IRREVERSIBLE,
    id: 'DYNAMIC EXECUTE',
  },
  // OR-T1709, the two directions of reading a DO block body.
  //
  // 16 is the false positive: a comment inside the body mentions DROP TABLE and
  // nothing in the body is irreversible, so the file must classify REVERSIBLE.
  // 17 is the false negative, and it is the one that costs data: the comment
  // ends in the word revoke, which is exactly the token that exempts the next
  // EXECUTE from the dynamic-SQL check, and the verb is concatenated so no
  // static rule can catch it.
  // 18 is the control on the fix for both: a literal inside a DO body is the
  // statement EXECUTE will run, so it must stay readable.
  '20990101000016_reversible_do_block_comment_names_drop_table.sql': {
    verdict: REVERSIBLE,
    id: null,
  },
  '20990101000017_irreversible_do_block_comment_ends_in_revoke.sql': {
    verdict: IRREVERSIBLE,
    id: 'DYNAMIC EXECUTE',
  },
  '20990101000018_irreversible_do_block_execute_literal_drop_table.sql': {
    verdict: IRREVERSIBLE,
    id: 'DROP TABLE',
  },
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
