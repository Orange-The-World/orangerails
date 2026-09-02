#!/usr/bin/env node
/**
 * CI gate: a migration under supabase/migrations/ may not DROP a policy by enumerating
 * whatever pg_policies happens to return. It may only drop a policy it names.
 *
 * THE DEFECT THIS PREVENTS (OR-T1324, OR-T1262). supabase/migrations/20260421200000_platforms_subaccounts.sql
 * contains a DO block that loops over pg_policies for a table and EXECUTEs a DROP POLICY built
 * with format('...%I...', r.policyname) for whatever it finds. It ate a co-admin policy created
 * 25 hours earlier by a different migration, plus a second policy on the same table, and nobody
 * noticed for four months. The block's own header comment said the enumeration was deliberate,
 * "defending against policies added by future migrations we don't know about yet" -- that is
 * exactly what made it dangerous: it was written to destroy things its author had not seen.
 *
 * WHAT THIS CHECKS. Scoped to files under supabase/migrations/ that are ADDED or CHANGED in the
 * current diff (see "SCOPE" below for why). Inside those files it flags a DROP POLICY whose
 * target is not a literal:
 *   1. DROP POLICY text found inside the argument of an EXECUTE statement. Postgres cannot take
 *      a placeholder (a variable, a format() %I/%s, string concatenation) in plain DDL syntax at
 *      all -- the ONLY way to make a DROP POLICY target dynamic is to build it as a string and
 *      run it with EXECUTE. So "is this DROP POLICY text inside an EXECUTE span" is a complete
 *      test for "is this target dynamic", not a heuristic that happens to catch the known case.
 *   2. A loop reading pg_policies or pg_policy anywhere in the file, alongside DROP POLICY text
 *      anywhere in the file. Kept as an independent signal because OR-T1376 names it explicitly,
 *      even though in valid PL/pgSQL it is always also caught by signal 1.
 * A bare `DROP POLICY IF EXISTS "name" ON schema.table;` outside any EXECUTE is never flagged:
 * that syntax cannot take a variable target, so it is always literal, by construction.
 *
 * WHY A TEXT LINT AND NOT A SCHEMA ORACLE. There is no machine-readable "expected policy set" for
 * a table anywhere in this repo -- it is spread across every migration that ever created one,
 * which is the same enumeration problem that caused the bug. Building a manifest means keeping it
 * true forever, and a manifest that drifts is worse than no manifest, because it is believed. This
 * check needs no source of truth beyond the diff in front of it.
 *
 * SCOPE: only files ADDED or CHANGED in the current pull request (or push) diff, never the whole
 * migrations directory. An existing migration that predates this gate, such as the 20260421200000
 * file above, is never re-examined: rewriting migration history is out of scope here (whether to
 * restore the dropped policies is a separate open decision tracked on OR-T1324).
 *
 * WHY "0 FILES EXAMINED" IS NOT ALWAYS A FAILURE, and when it is. Most pull requests do not touch
 * a migration at all, and scoring that red would block every unrelated PR in the repo, so "0
 * migration files in this diff" is a real, legitimate PASS, and it is printed, never swallowed
 * silently. What IS a hard failure, and never scored as a pass: a pull_request event missing its
 * base/head sha (a wiring bug in this file's own workflow step, not evidence anything is safe), or
 * the git diff command itself erroring (usually a checkout with too-shallow history). See
 * changedMigrationFiles() below -- it throws for those, and returns {skip:true} only for the
 * ordinary "not a PR, or a push with nothing to diff against" case.
 *
 * ESCAPE HATCH: a single-line marker comment on the line directly above a flagged line,
 * "-- lint-allow-dynamic-policy-drop: <reason>", suppresses that one finding. The reason is
 * required and checked: a marker with nothing after the colon does not suppress anything. There
 * is no global off switch.
 *
 * Run `node scripts/check-migration-policy-drops.mjs --selftest` to exercise the parser and the
 * marker logic without touching git or the filesystem beyond this file.
 */

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const MIGRATIONS_DIR = "supabase/migrations";
const ALLOW_MARKER_RE = /^\s*--\s*lint-allow-dynamic-policy-drop:\s*(\S.*)$/i;

/**
 * Strip -- line comments and /* block comments *\/, replacing removed characters with spaces so
 * every line and character offset in the result still lines up with the original text.
 * Single-quoted strings and dollar-quoted bodies are copied through UNCHANGED: that is
 * deliberately where the dangerous code lives (inside EXECUTE format('...'), inside a DO $$
 * block), so this check must not blind itself to them the way a grant-scanner reasonably can.
 */
export function stripComments(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      while (i < sql.length && sql[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    if (two === "/*") {
      let depth = 1;
      out += "  ";
      i += 2;
      while (i < sql.length && depth > 0) {
        const t = sql.slice(i, i + 2);
        if (t === "/*") { depth += 1; out += "  "; i += 2; continue; }
        if (t === "*/") { depth -= 1; out += "  "; i += 2; continue; }
        out += sql[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }
    if (sql[i] === "'") {
      out += sql[i]; i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { out += "''"; i += 2; continue; }
        if (sql[i] === "'") { out += "'"; i += 1; break; }
        out += sql[i]; i += 1;
      }
      continue;
    }
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

/** 1-based line number of a character offset in `cleaned`. */
function lineAt(cleaned, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < cleaned.length; i += 1) if (cleaned[i] === "\n") line += 1;
  return line;
}

/**
 * Every top-level EXECUTE ... ; span in `cleaned`. No paren-depth tracking is needed: a `;`
 * cannot legally appear inside a string or dollar-quoted body without being escaped/quoted, and
 * cannot appear at all inside a parenthesised expression outside of one, so the first `;` seen
 * while NOT inside a string or dollar-quote correctly ends the EXECUTE statement.
 */
function executeSpans(cleaned) {
  const spans = [];
  const re = /\bEXECUTE\b/gi;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    let i = re.lastIndex;
    while (i < cleaned.length) {
      const ch = cleaned[i];
      if (ch === "'") {
        i += 1;
        while (i < cleaned.length) {
          if (cleaned[i] === "'" && cleaned[i + 1] === "'") { i += 2; continue; }
          if (cleaned[i] === "'") { i += 1; break; }
          i += 1;
        }
        continue;
      }
      const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(cleaned.slice(i));
      if (dollar) {
        const tag = dollar[0];
        const end = cleaned.indexOf(tag, i + tag.length);
        i = end === -1 ? cleaned.length : end + tag.length;
        continue;
      }
      if (ch === ";") { i += 1; break; }
      i += 1;
    }
    spans.push({ start: m.index, end: i });
    re.lastIndex = i;
  }
  return spans;
}

/**
 * Findings for one migration's SQL text. See the file header for the two signatures. Returns
 * an array of { line, message }, both 1-based against the ORIGINAL source (stripComments never
 * changes line count or offsets, so a caller can index straight into sql.split("\n")).
 */
export function scan(sql) {
  const cleaned = stripComments(sql);
  const findings = [];

  for (const span of executeSpans(cleaned)) {
    const spanText = cleaned.slice(span.start, span.end);
    if (!/DROP\s+POLICY/i.test(spanText)) continue;
    const line = lineAt(cleaned, span.start);
    findings.push({
      line,
      message:
        `EXECUTE statement starting at line ${line} builds a DROP POLICY target at runtime ` +
        `(format()/%I/%s or string concatenation). Name the policy literally, or add ` +
        `"-- lint-allow-dynamic-policy-drop: <reason>" on the line above if this is deliberate.`,
    });
  }

  const loopMatch = /FROM\s+pg_polic(?:y|ies)\b/i.exec(cleaned);
  if (loopMatch && /DROP\s+POLICY/i.test(cleaned)) {
    const line = lineAt(cleaned, loopMatch.index);
    findings.push({
      line,
      message:
        `Loop reads pg_policies/pg_policy (line ${line}) in a file that also drops a policy. ` +
        `Dropping whatever the catalog happens to return destroys policies this migration never ` +
        `named, including ones added by later migrations it cannot see. Add ` +
        `"-- lint-allow-dynamic-policy-drop: <reason>" on the line above the drop if deliberate.`,
    });
  }

  return findings;
}

/** Drop any finding whose immediately preceding source line carries the opt-out marker. */
export function applyMarkers(findings, sourceLines) {
  const kept = [];
  const allowed = [];
  for (const f of findings) {
    const prev = sourceLines[f.line - 2] ?? "";
    const marker = ALLOW_MARKER_RE.exec(prev);
    if (marker) {
      allowed.push({ ...f, reason: marker[1].trim() });
    } else {
      kept.push(f);
    }
  }
  return { kept, allowed };
}

/* ------------------------------------------------------------------ self-test ------ */

// Verbatim from supabase/migrations/20260421200000_platforms_subaccounts.sql (dev, read
// 2026-09-02): the DO block that ate a co-admin policy 25 hours after it was created and went
// unnoticed for four months. This is the OR-T1376 fixture -- prove RED on it before anything
// else about this check matters.
const FIXTURE_DYNAMIC_DO_BLOCK = `
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'connections' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.connections', r.policyname);
  END LOOP;

  FOR r IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'encrypted_transactions' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.encrypted_transactions', r.policyname);
  END LOOP;
END $$;
`;

const CASES = [
  {
    name: "the real 20260421200000 DO block goes RED (2 dynamic EXECUTEs + the loop signature)",
    sql: FIXTURE_DYNAMIC_DO_BLOCK,
    expect: 3,
  },
  {
    name: "a literal DROP POLICY IF EXISTS is never flagged",
    sql: `DROP POLICY IF EXISTS "co_admin_read" ON public.workspace_admins;\nCREATE POLICY "co_admin_read" ON public.workspace_admins FOR SELECT TO authenticated USING (true);`,
    expect: 0,
  },
  {
    name: "a literal DROP POLICY without IF EXISTS is never flagged",
    sql: `DROP POLICY "x" ON public.y;`,
    expect: 0,
  },
  {
    name: "EXECUTE format() with %I, no loop, is flagged",
    sql: `DO $$ BEGIN EXECUTE format('DROP POLICY IF EXISTS %I ON public.foo', v_name); END $$;`,
    expect: 1,
  },
  {
    name: "EXECUTE built by string concatenation (no format()) is still flagged",
    sql: `DO $$ BEGIN EXECUTE 'DROP POLICY ' || quote_ident(r.policyname) || ' ON public.bar'; END $$;`,
    expect: 1,
  },
  {
    name: "a comment mentioning DROP POLICY is not a statement and is not flagged",
    sql: `-- this migration does not DROP POLICY dynamically\nSELECT 1;`,
    expect: 0,
  },
  {
    name: "reading pg_policies with no DROP POLICY anywhere is not flagged",
    sql: `SELECT policyname FROM pg_policies WHERE schemaname = 'public';`,
    expect: 0,
  },
  {
    name: "the full real file shape: fixture drop plus a literal drop elsewhere, only the dynamic block is flagged",
    sql: FIXTURE_DYNAMIC_DO_BLOCK +
      `\nDROP POLICY IF EXISTS "Direct users can read connections via their subaccount" ON public.connections;\n` +
      `CREATE POLICY "x" ON public.connections FOR SELECT TO authenticated USING (true);`,
    expect: 3,
  },
];

function selftestScan() {
  let failed = 0;
  for (const c of CASES) {
    const got = scan(c.sql).length;
    if (got !== c.expect) {
      failed += 1;
      console.error(`  FAIL ${c.name}: expected ${c.expect} finding(s), got ${got}`);
    }
  }
  return failed;
}

function selftestMarkers() {
  let failed = 0;

  const withReason =
    `DO $$ BEGIN\n` +
    `-- lint-allow-dynamic-policy-drop: reindexing tenant policies, tracked in OR-T0000\n` +
    `EXECUTE format('DROP POLICY IF EXISTS %I ON public.foo', v_name);\n` +
    `END $$;`;
  const findings = scan(withReason);
  const { kept, allowed } = applyMarkers(findings, withReason.split("\n"));
  if (findings.length !== 1) {
    failed += 1;
    console.error(`  FAIL marker fixture: expected scan() to find 1, got ${findings.length}`);
  }
  if (kept.length !== 0) {
    failed += 1;
    console.error(`  FAIL marker suppression: expected 0 kept, got ${kept.length}`);
  }
  if (allowed.length !== 1 || allowed[0].reason !== "reindexing tenant policies, tracked in OR-T0000") {
    failed += 1;
    console.error(`  FAIL marker reason: got ${JSON.stringify(allowed)}`);
  }

  // A marker with nothing after the colon must NOT suppress -- an empty escape hatch is a
  // global off switch wearing a disguise, and OR-T1376 explicitly forbids one.
  const noReason =
    `DO $$ BEGIN\n-- lint-allow-dynamic-policy-drop:\nEXECUTE format('DROP POLICY IF EXISTS %I ON public.foo', v_name);\nEND $$;`;
  const f2 = scan(noReason);
  const r2 = applyMarkers(f2, noReason.split("\n"));
  if (r2.kept.length !== 1) {
    failed += 1;
    console.error(`  FAIL empty-reason marker must not suppress: kept ${r2.kept.length}`);
  }

  return failed;
}

function selftest() {
  const failed = selftestScan() + selftestMarkers();
  if (failed) {
    console.error(`migration-policy-drop self-test FAILED: ${failed} case(s).`);
    process.exit(1);
  }
  console.log(`migration-policy-drop self-test OK: ${CASES.length} scan case(s) + marker suppression pass.`);
}

/* ----------------------------------------------------------------- diff scope ------ */

const ALL_ZERO_SHA = /^0+$/;

/**
 * Which files under MIGRATIONS_DIR were added or changed in this run's diff.
 * Returns { skip: true, reason } when there is genuinely nothing to diff (not a pull_request
 * event, or a push with no usable before-sha) -- a normal, loudly-reported PASS. THROWS when the
 * file-selection mechanism itself is broken: a pull_request event with no base/head sha, or a
 * git diff command that errors. That must never be scored as "0 files examined, pass".
 */
function changedMigrationFiles() {
  const event = process.env.GITHUB_EVENT_NAME || "";
  let base;
  let head;

  if (event === "pull_request") {
    base = process.env.PR_BASE_SHA || "";
    head = process.env.PR_HEAD_SHA || "";
    if (!base || !head) {
      throw new Error(
        `pull_request event but PR_BASE_SHA/PR_HEAD_SHA are missing from the workflow env ` +
        `(base="${base}" head="${head}"). That is a wiring bug in ci.yml, not evidence the ` +
        `migrations in this PR are safe.`);
    }
  } else if (event === "push") {
    base = process.env.PUSH_BEFORE_SHA || "";
    head = process.env.PUSH_AFTER_SHA || process.env.GITHUB_SHA || "";
    if (!base || ALL_ZERO_SHA.test(base) || !head) {
      return {
        skip: true,
        reason: "push event with no usable before-sha (new branch or force-push): cannot diff safely",
      };
    }
  } else {
    return { skip: true, reason: `event "${event}" carries no PR or push diff to scope this check to` };
  }

  let stdout;
  try {
    stdout = execFileSync(
      "git",
      ["diff", "--no-color", "--diff-filter=AM", "--name-only", `${base}...${head}`, "--", MIGRATIONS_DIR],
      { encoding: "utf8" });
  } catch (e) {
    throw new Error(
      `git diff ${base}...${head} -- ${MIGRATIONS_DIR} failed: ${e.message}. The file-selection ` +
      `mechanism is broken, not proof the migrations are safe. This usually means the checkout ` +
      `step needs fetch-depth: 0 so both commits are reachable.`);
  }

  const files = stdout.split("\n").map((l) => l.trim()).filter((l) => l.endsWith(".sql"));
  return { skip: false, base, head, files };
}

/* ----------------------------------------------------------------------- main ------ */

if (process.argv.includes("--selftest")) {
  selftest();
} else if (!existsSync(MIGRATIONS_DIR)) {
  console.log(`skip: no ${MIGRATIONS_DIR} in this repo`);
} else {
  let result;
  try {
    result = changedMigrationFiles();
  } catch (e) {
    console.error(`::error::migration policy-drop check: ${e.message}`);
    process.exit(1);
  }

  if (result.skip) {
    console.log(`::notice::migration policy-drop check: skipped, ${result.reason}`);
  } else {
    const short = (s) => s.slice(0, 7);
    console.log(
      `Examined ${result.files.length} migration file(s) added/changed in this diff ` +
      `(base ${short(result.base)} -> head ${short(result.head)}).`);

    if (result.files.length === 0) {
      console.log("No migration files changed in this diff. Nothing to check. PASS.");
    } else {
      const fail = [];
      const allowedTotal = [];
      for (const path of result.files) {
        if (!existsSync(path)) continue; // deleted again in a later commit of the same PR
        const sql = readFileSync(path, "utf8");
        const findings = scan(sql);
        const { kept, allowed } = applyMarkers(findings, sql.split("\n"));
        for (const a of allowed) {
          allowedTotal.push(a);
          console.log(`ALLOWED (marker) ${path}:${a.line} -- ${a.reason}`);
        }
        for (const f of kept) {
          fail.push({ path, ...f });
          console.error(`::error file=${path},line=${f.line}::${f.message}`);
        }
      }

      if (fail.length) {
        console.error(
          `migration policy-drop check FAILED: ${fail.length} finding(s) across ` +
          `${result.files.length} examined file(s):\n` +
          fail.map((f) => `  - ${f.path}:${f.line}: ${f.message}`).join("\n"));
        process.exit(1);
      }
      console.log(
        `migration policy-drop check OK: ${result.files.length} file(s) examined, ` +
        `${allowedTotal.length} marker-allowed, 0 unmarked dynamic policy drop(s).`);
    }
  }
}
