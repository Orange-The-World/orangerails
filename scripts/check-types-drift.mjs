#!/usr/bin/env node
/**
 * check-types-drift
 *
 * Fails when src/integrations/supabase/types.ts no longer matches the schema
 * that is actually applied to the target Supabase project.
 *
 * Exit codes, and they are three different facts:
 *   0  the type file agrees with the applied schema
 *   1  it differs (or a baseline waiver has gone stale)
 *   2  UNKNOWN: one of the two sides could not be read, so nothing was compared
 *
 * Never exits 0 because it could not look. "I could not check" and "it is
 * clean" are different answers and this prints them differently.
 *
 * Environment:
 *   SUPABASE_ACCESS_TOKEN  required, same token the deploy workflow uses
 *   SUPABASE_REF           required, the project ref for this branch
 *   GITHUB_STEP_SUMMARY    optional, appended to when present
 *
 * The token is never printed and no response body is ever echoed.
 */

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";

export const TYPES_PATH = "src/integrations/supabase/types.ts";
export const BASELINE_PATH = "supabase/types-drift-baseline.json";

/**
 * One row per column of every table, partitioned table, view and materialized
 * view in the public schema. attidentity and attgenerated count as a default:
 * both mean an insert may legitimately omit the column.
 */
export const SCHEMA_SQL = [
  "select c.relname as relation,",
  "       c.relkind as relkind,",
  "       a.attname as column_name,",
  "       (not a.attnotnull) as is_nullable,",
  "       (a.atthasdef or a.attidentity <> '' or a.attgenerated <> '') as has_default",
  "  from pg_class c",
  "  join pg_namespace n on n.oid = c.relnamespace",
  "  join pg_attribute a on a.attrelid = c.oid",
  " where n.nspname = 'public'",
  "   and c.relkind in ('r','p','v','m')",
  "   and a.attnum > 0",
  "   and not a.attisdropped",
  " order by c.relname, a.attname;",
].join("\n");

/**
 * Parse the public.Tables block of a Supabase generated type file.
 *
 * The file is machine generated with a fixed two space indent ladder, so this
 * reads it line by line rather than pulling in a TypeScript parser. If the
 * shape ever changes this returns an empty map, and an empty map is treated as
 * UNKNOWN by the caller, never as a clean result.
 */
export function parseTypesFile(source) {
  const tables = new Map();
  let inPublic = false;
  let inTables = false;
  let table = null;
  let section = null;

  for (const raw of source.split("\n")) {
    const line = raw.replace(/\r$/, "");

    if (!inPublic) {
      if (line === "  public: {") inPublic = true;
      continue;
    }

    if (!inTables) {
      if (line === "    Tables: {") inTables = true;
      continue;
    }

    if (table === null) {
      const opened = /^ {6}([A-Za-z0-9_]+): \{$/.exec(line);
      if (opened) {
        table = {
          name: opened[1],
          sections: { Row: new Map(), Insert: new Map(), Update: new Map() },
        };
        continue;
      }
      // Four spaces and a brace closes Tables itself.
      if (line === "    }") break;
      continue;
    }

    if (section === null) {
      const opened = /^ {8}(Row|Insert|Update): \{$/.exec(line);
      if (opened) {
        section = opened[1];
        continue;
      }
      if (line === "      }") {
        tables.set(table.name, table);
        table = null;
      }
      continue;
    }

    const field = /^ {10}([A-Za-z0-9_]+)(\??): (.+?)$/.exec(line);
    if (field) {
      table.sections[section].set(field[1], {
        optional: field[2] === "?",
        type: field[3].trim(),
      });
      continue;
    }
    if (line === "        }") section = null;
  }

  return tables;
}

/** Fold the schema rows into one entry per relation. */
export function liveFromRows(rows) {
  const truthy = (v) => v === true || v === "t" || v === "true" || v === 1;
  const live = new Map();
  for (const row of rows) {
    const name = row.relation;
    if (!live.has(name)) {
      live.set(name, {
        name,
        kind: row.relkind === "r" || row.relkind === "p" ? "table" : "view",
        columns: new Map(),
      });
    }
    live.get(name).columns.set(row.column_name, {
      nullable: truthy(row.is_nullable),
      hasDefault: truthy(row.has_default),
    });
  }
  return live;
}

/**
 * Every way the type file and the live schema can disagree, in the three
 * dimensions that have actually caused harm here.
 */
export function buildFindings(live, types) {
  const findings = [];

  for (const [name, rel] of live) {
    const declaredTable = types.get(name);
    if (!declaredTable) {
      findings.push({
        relation: name,
        kind: rel.kind === "view" ? "missing-view" : "missing-table",
        detail:
          "public." +
          name +
          " is live with " +
          rel.columns.size +
          " column(s) and does not appear in the type file at all",
      });
      continue;
    }

    const row = declaredTable.sections.Row;
    const insert = declaredTable.sections.Insert;

    for (const [column, meta] of rel.columns) {
      const declared = row.get(column);
      if (!declared) {
        findings.push({
          relation: name,
          kind: "missing-column",
          detail:
            name + "." + column + " is in the database and not in Row",
        });
      } else {
        const declaredNullable = /\|\s*null\b/.test(declared.type);
        if (meta.nullable !== declaredNullable) {
          findings.push({
            relation: name,
            kind: "nullability",
            detail:
              name +
              "." +
              column +
              " is " +
              (meta.nullable ? "NULLABLE" : "NOT NULL") +
              " in the database and Row declares it " +
              (declaredNullable ? "nullable" : "not nullable"),
          });
        }
      }

      const declaredInsert = insert.get(column);
      if (!declaredInsert) {
        findings.push({
          relation: name,
          kind: "missing-insert-column",
          detail:
            name + "." + column + " is in the database and not in Insert",
        });
        continue;
      }
      const mayBeOmitted = meta.nullable || meta.hasDefault;
      if (mayBeOmitted && !declaredInsert.optional) {
        findings.push({
          relation: name,
          kind: "insert-too-strict",
          detail:
            name +
            "." +
            column +
            " is nullable or has a default, so Insert should mark it optional",
        });
      }
      if (!mayBeOmitted && declaredInsert.optional) {
        findings.push({
          relation: name,
          kind: "insert-too-loose",
          detail:
            name +
            "." +
            column +
            " is NOT NULL with no default, so Insert must require it. As written, an insert that omits it typechecks and the database refuses it at runtime",
        });
      }
    }

    for (const column of row.keys()) {
      if (!rel.columns.has(column)) {
        findings.push({
          relation: name,
          kind: "extra-column",
          detail:
            "Row declares " +
            name +
            "." +
            column +
            " and the database does not have it",
        });
      }
    }
  }

  for (const name of types.keys()) {
    if (!live.has(name)) {
      findings.push({
        relation: name,
        kind: "extra-table",
        detail:
          "the type file declares " +
          name +
          " and the database does not have it",
      });
    }
  }

  return findings;
}

/**
 * Split findings into blocking and waived.
 *
 * A waiver covers one relation by name and is a checked in, reviewed line with
 * a reason and a ticket. A waiver that no longer covers anything is itself a
 * blocking finding: a stale waiver is how a list like this rots into a
 * wildcard that hides the next real difference.
 */
export function applyBaseline(findings, baseline) {
  const waived = new Set(Object.keys((baseline && baseline.waived) || {}));
  const blocking = [];
  const suppressed = [];

  for (const finding of findings) {
    if (waived.has(finding.relation)) suppressed.push(finding);
    else blocking.push(finding);
  }

  const covered = new Set(suppressed.map((f) => f.relation));
  for (const name of waived) {
    if (!covered.has(name)) {
      blocking.push({
        relation: name,
        kind: "stale-baseline",
        detail:
          name +
          " is waived in " +
          BASELINE_PATH +
          " and no longer differs. Delete its entry.",
      });
    }
  }

  return { blocking, suppressed };
}

/** Returns a reason string when a side was not readable, or null when both were. */
export function assertReadable(live, types) {
  if (live.size === 0) {
    return "the schema query returned no relations, so the live schema was NOT read";
  }
  if (types.size === 0) {
    return (
      "no tables could be parsed out of " +
      TYPES_PATH +
      ", so the type file was NOT read"
    );
  }
  return null;
}

function summary(text) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  try {
    appendFileSync(target, text + "\n");
  } catch {
    // The summary is a convenience. Never let it change the verdict.
  }
}

function unknown(reason) {
  summary(
    "## Types drift state UNKNOWN\n\n" +
      reason +
      "\n\nThis is not a report that the types are correct and not a report that\n" +
      "they are wrong. Nothing was compared.",
  );
  console.error("::error::types drift state UNKNOWN: " + reason);
  process.exit(2);
}

async function fetchSchema(ref, token) {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response;
    try {
      response = await fetch(
        "https://api.supabase.com/v1/projects/" + ref + "/database/query",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: SCHEMA_SQL }),
        },
      );
    } catch (err) {
      console.error(
        "schema query attempt " + attempt + "/3 failed to connect: " + err.name,
      );
      if (attempt < 3) await new Promise((r) => setTimeout(r, 10000));
      continue;
    }
    lastStatus = response.status;
    if (response.ok) {
      let parsed;
      try {
        parsed = await response.json();
      } catch {
        unknown("the schema query returned a success status and a body that is not JSON.");
      }
      if (!Array.isArray(parsed)) {
        unknown(
          "the schema query returned a success status but not a JSON array of rows.",
        );
      }
      return parsed;
    }
    console.error("schema query attempt " + attempt + "/3 returned HTTP " + response.status);
    if (attempt < 3) await new Promise((r) => setTimeout(r, 10000));
  }
  unknown(
    "the Supabase Management API did not return a success status after 3 attempts (last status " +
      lastStatus +
      "). Most often an expired or rotated SUPABASE_ACCESS_TOKEN, or the project being paused.",
  );
  return [];
}

async function main() {
  const ref = process.env.SUPABASE_REF;
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!ref) unknown("SUPABASE_REF is not set, so there is no project to read.");
  if (!token) unknown("SUPABASE_ACCESS_TOKEN is not set, so the schema cannot be read.");
  if (!existsSync(TYPES_PATH)) unknown(TYPES_PATH + " does not exist.");

  const live = liveFromRows(await fetchSchema(ref, token));
  const types = parseTypesFile(readFileSync(TYPES_PATH, "utf8"));

  const unreadable = assertReadable(live, types);
  if (unreadable) unknown(unreadable);

  let baseline = { waived: {} };
  if (existsSync(BASELINE_PATH)) {
    try {
      baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    } catch (err) {
      unknown(BASELINE_PATH + " is not valid JSON (" + err.name + ").");
    }
  }

  const { blocking, suppressed } = applyBaseline(
    buildFindings(live, types),
    baseline,
  );

  console.log(
    "compared " +
      live.size +
      " live relation(s) against " +
      types.size +
      " table(s) in " +
      TYPES_PATH +
      " on " +
      ref,
  );
  console.log(
    suppressed.length +
      " finding(s) waived by " +
      BASELINE_PATH +
      ", " +
      blocking.length +
      " blocking",
  );

  if (blocking.length === 0) {
    summary(
      "Types match the applied schema on `" +
        ref +
        "` (" +
        suppressed.length +
        " known difference(s) waived in `" +
        BASELINE_PATH +
        "`).",
    );
    console.log("no new drift.");
    return;
  }

  const lines = blocking.map((f) => "- `" + f.kind + "` " + f.detail);
  for (const line of lines) console.log(line.replace(/^- /, ""));

  summary(
    "## " +
      blocking.length +
      " type file difference(s) against `" +
      ref +
      "`\n\n" +
      "The deploy is blocked. `" +
      TYPES_PATH +
      "` no longer describes the applied schema.\n\n" +
      lines.join("\n") +
      "\n\nRegenerate with `npm run gen:types` (it needs SUPABASE_ACCESS_TOKEN and writes the file), commit the result, and\n" +
      "delete any `" +
      BASELINE_PATH +
      "` entry that the regeneration clears.",
  );
  console.error(
    "::error::" +
      blocking.length +
      " difference(s) between " +
      TYPES_PATH +
      " and the applied schema on " +
      ref +
      " -- DEPLOY BLOCKED.",
  );
  process.exit(1);
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((err) => {
    unknown("the check itself threw before it could compare: " + err.message);
  });
}
