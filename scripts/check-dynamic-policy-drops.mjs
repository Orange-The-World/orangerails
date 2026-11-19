#!/usr/bin/env node
/**
 * CI text lint: refuse a migration that discovers policy names at runtime and drops them.
 *
 * This is deliberately a source check over migration files added or changed by a pull
 * request. It is not a schema oracle and does not try to reconstruct the policy set left by
 * the full migration history. A named DROP POLICY is reviewable; a dynamic one can remove a
 * policy the migration author has never seen.
 *
 * Allowed, because the policy target is a literal:
 *
 *   DROP POLICY IF EXISTS "known policy" ON public.example;
 *
 * Refused signatures include DROP POLICY inside dynamic SQL (EXECUTE or format()), a target
 * assembled with %I or %s, and the enumeration shape that reads pg_policies or pg_policy.
 * SQL comments are ignored, but quoted SQL is intentionally inspected because that is where
 * EXECUTE format(...) keeps the destructive statement.
 *
 * One finding can be acknowledged only on the immediately preceding line:
 *
 *   -- lint-allow-dynamic-policy-drop: <specific reason>
 *
 * The reason is required. The marker is per finding; there is no file-wide or global switch.
 *
 * WHAT THIS PROVES: every DROP POLICY text visible in each selected migration either names a
 * literal target or carries a visible, reasoned marker on the line immediately above it.
 *
 * WHAT THIS DOES NOT PROVE: that a stated reason is true, that generated SQL which never
 * contains the adjacent words DROP POLICY is safe, or that a database has the policy set the
 * repository expects. Those are outside a text lint's evidence.
 *
 * Run `node scripts/check-dynamic-policy-drops.mjs --selftest` to exercise the decision against
 * committed fixtures. Normal CI supplies a NUL-delimited changed-path list with --paths-from.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = "supabase/migrations";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const FIXTURES_DIR = join(dirname(SCRIPT_PATH), "fixtures", "dynamic-policy-drops");
const ALLOW_MARKER = /^\s*--\s*lint-allow-dynamic-policy-drop:\s*(\S(?:.*\S)?)\s*$/i;

/**
 * Replace SQL comments with spaces while preserving newlines, quoted strings, and their byte
 * offsets. Quoted strings stay visible because dynamic DROP POLICY statements live inside
 * them. Dollar-quote delimiters are treated as transparent so PL/pgSQL bodies are inspected.
 */
export function maskComments(sql) {
  const chars = [...sql];
  let state = "code";

  for (let i = 0; i < chars.length; i += 1) {
    const here = chars[i];
    const next = chars[i + 1];

    if (state === "line-comment") {
      if (here === "\n") state = "code";
      else chars[i] = " ";
      continue;
    }
    if (state === "block-comment") {
      if (here === "*" && next === "/") {
        chars[i] = " ";
        chars[i + 1] = " ";
        i += 1;
        state = "code";
      } else if (here !== "\n" && here !== "\r") {
        chars[i] = " ";
      }
      continue;
    }
    if (state === "single-quote") {
      if (here === "'" && next === "'") {
        i += 1;
      } else if (here === "'") {
        state = "code";
      }
      continue;
    }
    if (state === "double-quote") {
      if (here === '"' && next === '"') {
        i += 1;
      } else if (here === '"') {
        state = "code";
      }
      continue;
    }

    if (here === "-" && next === "-") {
      chars[i] = " ";
      chars[i + 1] = " ";
      i += 1;
      state = "line-comment";
    } else if (here === "/" && next === "*") {
      chars[i] = " ";
      chars[i + 1] = " ";
      i += 1;
      state = "block-comment";
    } else if (here === "'") {
      state = "single-quote";
    } else if (here === '"') {
      state = "double-quote";
    }
  }

  return chars.join("");
}

function lineNumberAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

function quoteContextAt(text, offset) {
  let quoted = null;
  for (let i = 0; i < offset; i += 1) {
    if (quoted === "single" && text[i] === "'" && text[i + 1] === "'") {
      i += 1;
      continue;
    }
    if (quoted === "double" && text[i] === '"' && text[i + 1] === '"') {
      i += 1;
      continue;
    }
    if (text[i] === "'" && quoted !== "double") quoted = quoted === "single" ? null : "single";
    if (text[i] === '"' && quoted !== "single") quoted = quoted === "double" ? null : "double";
  }
  return quoted;
}

function nearbyDynamicCall(masked, offset) {
  const before = masked.slice(Math.max(0, offset - 1200), offset);
  const statement = before.slice(before.lastIndexOf(";") + 1);
  return /\bEXECUTE\b|\bformat\s*\(/i.test(statement);
}

function nearbyCatalogEnumeration(masked, offset) {
  const before = masked.slice(Math.max(0, offset - 1400), offset);
  const lastFor = before.toUpperCase().lastIndexOf("FOR ");
  if (lastFor === -1) return false;
  const loop = before.slice(lastFor);
  if (/\bEND\s+LOOP\b/i.test(loop)) return false;
  return /\bIN\s+SELECT\b[\s\S]*?\b(?:FROM|JOIN)\s+(?:pg_catalog\.)?pg_(?:policies|policy)\b/i.test(
    loop,
  );
}

/** Return one finding for each dynamic DROP POLICY occurrence in a SQL source string. */
export function findingsForSql(sql) {
  const masked = maskComments(sql);
  const sourceLines = sql.split(/\r?\n/);
  const findings = [];
  const dropPolicy = /\bDROP\s+POLICY\b/gi;
  let match;

  while ((match = dropPolicy.exec(masked)) !== null) {
    const after = masked.slice(dropPolicy.lastIndex);
    const literalTarget =
      /^\s+(?:IF\s+EXISTS\s+)?(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s+ON\b/i.test(after);
    const quoteContext = quoteContextAt(masked, match.index);
    if (quoteContext === "double") continue;
    const inDynamicSql = nearbyDynamicCall(masked, match.index);
    const catalogEnumeration = nearbyCatalogEnumeration(masked, match.index);
    const hasPlaceholder = /%[Is]/i.test(after.slice(0, 240));

    // A quoted prose string can mention DROP POLICY without executing it. Dynamic calls and
    // catalog loops are still inspected, as is an explicit identifier/string placeholder;
    // ordinary strings are not treated as SQL by name alone.
    if (quoteContext === "single" && !inDynamicSql && !catalogEnumeration && !hasPlaceholder) {
      continue;
    }
    // A direct literal target is always allowed, even if unrelated surrounding code reads a
    // policy catalog. The dangerous property is runtime selection of the target, not the
    // presence of catalog vocabulary elsewhere in the block.
    if (literalTarget && !inDynamicSql) continue;

    const line = lineNumberAt(masked, match.index);
    const marker = line > 1 ? ALLOW_MARKER.exec(sourceLines[line - 2] ?? "") : null;
    const reasons = [];
    if (inDynamicSql) reasons.push("DROP POLICY is inside dynamic SQL");
    if (!literalTarget) reasons.push("the policy target is not a literal followed by ON");
    if (hasPlaceholder) reasons.push("the statement substitutes %I or %s");
    if (catalogEnumeration)
      reasons.push("the statement is inside a loop over pg_policies/pg_policy");

    findings.push({
      line,
      source: (sourceLines[line - 1] ?? "").trim(),
      reason: reasons.join("; ") || "the policy drop is dynamic",
      allowedReason: marker ? marker[1] : null,
    });
  }

  return findings;
}

/** The complete file-set decision. Empty input is a loud failure, never a pass. */
export function verdict(files) {
  const findings = [];
  const allowed = [];

  if (files.length === 0) {
    return {
      findings,
      allowed,
      errors: [
        "examined 0 migration files. The diff range or file selection produced no input, so " +
          "this check proved nothing. That is a failure, not a pass.",
      ],
      examined: 0,
    };
  }

  for (const file of files) {
    for (const finding of findingsForSql(file.sql)) {
      const entry = { ...finding, file: file.name };
      if (finding.allowedReason) allowed.push(entry);
      else findings.push(entry);
    }
  }

  return { findings, allowed, errors: [], examined: files.length };
}

function pathsFrom(path) {
  const paths = readFileSync(path).toString().split("\0").filter(Boolean).sort();
  for (const candidate of paths) {
    if (!candidate.startsWith(MIGRATIONS_DIR + "/") || !candidate.endsWith(".sql")) {
      throw new Error(
        `selected path "${candidate}" is not a .sql file directly under ${MIGRATIONS_DIR}`,
      );
    }
    if (candidate.slice(MIGRATIONS_DIR.length + 1).includes("/")) {
      throw new Error(`selected path "${candidate}" is below a nested directory`);
    }
  }
  return paths;
}

function printVerdict(result) {
  for (const entry of result.allowed) {
    console.log(
      `::notice file=${entry.file},line=${entry.line}::dynamic DROP POLICY acknowledged: ` +
        entry.allowedReason,
    );
    console.log(`  ~ ${entry.file}:${entry.line}: ${entry.allowedReason}`);
  }

  for (const entry of result.findings) {
    console.error(
      `::error file=${entry.file},line=${entry.line}::dynamic DROP POLICY refused: ` + entry.reason,
    );
    console.error(`  > ${entry.file}:${entry.line}: ${entry.source}`);
  }

  for (const message of result.errors) console.error("::error::" + message);

  if (result.errors.length || result.findings.length) {
    console.error(
      `dynamic policy drop lint FAILED: examined ${result.examined} migration file(s); ` +
        `${result.findings.length} unacknowledged dynamic drop(s), ` +
        `${result.allowed.length} acknowledged.`,
    );
    console.error(
      "Name every policy in a literal DROP POLICY statement. If runtime discovery is truly " +
        "intentional, put this immediately above that one dynamic DROP POLICY line:\n\n" +
        "    -- lint-allow-dynamic-policy-drop: <specific reason>",
    );
    return 1;
  }

  console.log(
    `dynamic policy drop lint OK: examined ${result.examined} migration file(s); ` +
      `0 unacknowledged dynamic drops, ${result.allowed.length} acknowledged.`,
  );
  return 0;
}

/* ------------------------------------------------------------------- self test ------ */

function selftest() {
  const unsafe = readFileSync(join(FIXTURES_DIR, "unsafe-enumeration.sql"), "utf8");
  const literal = readFileSync(join(FIXTURES_DIR, "literal-policy-name.sql"), "utf8");
  const allowed = readFileSync(join(FIXTURES_DIR, "allowed-dynamic-drop.sql"), "utf8");
  const cases = [
    {
      name: "the verbatim enumeration fixture produces two unacknowledged findings",
      files: [{ name: "unsafe-enumeration.sql", sql: unsafe }],
      expectStatus: 1,
      expectFindings: 2,
      expectLines: [6, 10],
    },
    {
      name: "a literal DROP POLICY is not flagged",
      files: [{ name: "literal-policy-name.sql", sql: literal }],
      expectStatus: 0,
      expectFindings: 0,
    },
    {
      name: "a reasoned marker allows only the immediately following dynamic drop",
      files: [{ name: "allowed-dynamic-drop.sql", sql: allowed }],
      expectStatus: 0,
      expectFindings: 0,
      expectAllowed: 1,
    },
    {
      name: "an empty migration diff is a distinct loud failure",
      files: [],
      expectStatus: 1,
      expectFindings: 0,
      expectErrors: 1,
    },
  ];

  const parserCases = [
    {
      name: "commented examples do not count",
      sql: "-- DROP POLICY IF EXISTS %I ON public.example;\n/* DROP POLICY x ON public.t; */\n",
      expect: 0,
    },
    {
      name: "an empty marker reason does not suppress a finding",
      sql: "-- lint-allow-dynamic-policy-drop:\nEXECUTE format('DROP POLICY %I ON public.t', name);\n",
      expect: 1,
    },
    {
      name: "a bare literal policy identifier is allowed",
      sql: "DROP POLICY IF EXISTS known_policy ON public.example;\n",
      expect: 0,
    },
    {
      name: "a direct literal target remains allowed inside a catalog loop",
      sql:
        "FOR r IN SELECT policyname FROM pg_policies LOOP\n" +
        '  DROP POLICY IF EXISTS "known policy" ON public.example;\n' +
        "END LOOP;\n",
      expect: 0,
    },
    {
      name: "a multiline format call is detected",
      sql: "EXECUTE format(\n  'DROP POLICY IF EXISTS %I ON public.example',\n  policy_name\n);\n",
      expect: 1,
    },
    {
      name: "a placeholder in an assigned dynamic statement is detected before EXECUTE",
      sql: "query := 'DROP POLICY IF EXISTS %I ON public.example';\nEXECUTE format(query, name);\n",
      expect: 1,
    },
    {
      name: "a prose string and quoted identifier containing DROP POLICY are ignored",
      sql:
        "COMMENT ON TABLE public.t IS 'Never type DROP POLICY known ON public.t';\n" +
        'CREATE POLICY "words DROP POLICY are harmless" ON public.t USING (true);\n',
      expect: 0,
    },
    {
      name: "a marker is per-line and does not suppress the next dynamic drop too",
      sql:
        "-- lint-allow-dynamic-policy-drop: one reviewed compatibility cleanup\n" +
        "EXECUTE format('DROP POLICY %I ON public.t', first_name);\n" +
        "EXECUTE format('DROP POLICY %I ON public.t', second_name);\n",
      expect: 1,
      expectAllowed: 1,
    },
  ];

  let failed = 0;
  for (const testCase of parserCases) {
    const parsed = findingsForSql(testCase.sql);
    const got = parsed.filter((finding) => !finding.allowedReason).length;
    const allowedCount = parsed.filter((finding) => finding.allowedReason).length;
    if (got !== testCase.expect || allowedCount !== (testCase.expectAllowed ?? 0)) {
      failed += 1;
      console.error(
        `  FAIL ${testCase.name}: expected ${testCase.expect} unacknowledged and ` +
          `${testCase.expectAllowed ?? 0} acknowledged, got ${got} and ${allowedCount}`,
      );
    }
  }
  for (const testCase of cases) {
    const result = verdict(testCase.files);
    const status = result.errors.length || result.findings.length ? 1 : 0;
    const lines = result.findings.map((finding) => finding.line);
    const wrong =
      status !== testCase.expectStatus ||
      result.findings.length !== testCase.expectFindings ||
      result.allowed.length !== (testCase.expectAllowed ?? 0) ||
      result.errors.length !== (testCase.expectErrors ?? 0) ||
      (testCase.expectLines && testCase.expectLines.some((line) => !lines.includes(line)));
    if (wrong) {
      failed += 1;
      console.error(
        `  FAIL ${testCase.name}: status=${status}, findings=${result.findings.length}, ` +
          `allowed=${result.allowed.length}, errors=${result.errors.length}, ` +
          `lines=${lines.join(",") || "none"}`,
      );
    } else {
      console.log("  PASS " + testCase.name + ` (decision ${testCase.expectStatus})`);
    }
  }

  const total = parserCases.length + cases.length;
  if (failed) {
    console.error(`dynamic policy drop lint self-test FAILED: ${failed} of ${total} case(s).`);
    process.exit(1);
  }
  console.log(
    `dynamic policy drop lint self-test OK: ${total} cases exercised. The committed unsafe ` +
      "fixture reached the red decision with both file:line locations; the literal fixture " +
      "reached the clean decision; and a zero-file input reached the red decision.",
  );
}

/* ------------------------------------------------------------------------ main ------ */

if (process.argv.includes("--selftest")) {
  selftest();
} else {
  const fixtureArg = process.argv.find((argument) => argument.startsWith("--fixture="));
  const pathsArg = process.argv.find((argument) => argument.startsWith("--paths-from="));
  if (fixtureArg && pathsArg) {
    console.error("::error::use --fixture or --paths-from, not both.");
    process.exit(1);
  }
  if (!fixtureArg && !pathsArg) {
    console.error(
      "::error::--paths-from=<NUL-delimited file> is required. Without an explicit selection, " +
        "this check cannot know which migrations changed and must not report success.",
    );
    process.exit(1);
  }

  const files = [];
  try {
    if (fixtureArg) {
      const path = fixtureArg.slice("--fixture=".length);
      if (!path) throw new Error("--fixture needs a path");
      files.push({ name: path, sql: readFileSync(path, "utf8") });
    } else {
      const path = pathsArg.slice("--paths-from=".length);
      if (!path) throw new Error("--paths-from needs a path");
      for (const name of pathsFrom(path)) files.push({ name, sql: readFileSync(name, "utf8") });
    }
  } catch (err) {
    console.error(
      "::error::could not read the selected migration input (" +
        err.message +
        "). The scan " +
        "is incomplete, so this check is red rather than green.",
    );
    process.exit(1);
  }

  process.exit(printVerdict(verdict(files)));
}
