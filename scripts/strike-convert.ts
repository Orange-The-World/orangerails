#!/usr/bin/env bun
/**
 * Orange Rails , Strike → BitBooks converter (CLI).
 *
 * Usage:
 *   bun run scripts/strike-convert.ts --source csv  --in <strike.csv>            --out <out-dir>
 *   bun run scripts/strike-convert.ts --source api  --api-key XXX                --out <out-dir>
 *   bun run scripts/strike-convert.ts --source auto --api-key XXX --csv <file>   --out <out-dir>
 *
 * Outputs to <out-dir>:
 *   staged-import.json              , StagedImportPayload (Mode 2)
 *   journal-entries.csv             , per-section CSV (when JE rows present)
 *   categorization-suggestions.json , bulk-assign hints for the mapping UI
 *   _run-report.txt                 , counts, warnings, errors, path used
 *
 * Local-only: Strike plaintext data is sensitive (ZKA boundary). Do NOT run
 * on a shared server.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ingestStrike,
  type IngestStrikeOptions,
  type IngestStrikeResult,
} from "../src/connectors/strike";

type Args = {
  source: "auto" | "api" | "csv";
  apiKey?: string;
  csvPath?: string;
  outDir: string;
};

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {};
  let i = 2;
  while (i < argv.length) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case "--source":
        if (next !== "auto" && next !== "api" && next !== "csv") {
          throw new Error(`--source must be one of auto|api|csv (got ${next})`);
        }
        out.source = next;
        i += 2;
        break;
      case "--api-key":
        out.apiKey = next;
        i += 2;
        break;
      case "--csv":
      case "--in":
        out.csvPath = next;
        i += 2;
        break;
      case "--out":
        out.outDir = next;
        i += 2;
        break;
      default:
        throw new Error(`Unknown flag: ${a}`);
    }
  }
  if (!out.source) throw new Error("--source is required (auto|api|csv)");
  if (!out.outDir) throw new Error("--out is required");
  if (out.source === "csv" && !out.csvPath) throw new Error("--source csv requires --in/--csv");
  if (out.source === "api" && !out.apiKey) throw new Error("--source api requires --api-key");
  return out as Args;
}

function journalRowsToCsv(rows: Record<string, string>[]): string {
  if (rows.length === 0) return "";
  const headers = [
    "JE date",
    "JE ref #",
    "JE memo",
    "JE status",
    "Account code",
    "Account name",
    "Line description",
    "Wallet Currency",
    "Debit",
    "Credit",
  ];
  const keys = [
    "je_date",
    "je_ref_#",
    "je_memo",
    "je_status",
    "account_code",
    "account_name",
    "line_description",
    "wallet_currency",
    "debit",
    "credit",
  ];
  const esc = (v: string): string => {
    if (v === "") return "";
    if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
    return v;
  };
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(keys.map((k) => esc(r[k] ?? "")).join(","));
  }
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error((err as Error).message);
    console.error(
      "Usage:\n  strike-convert --source csv  --in <strike.csv> --out <dir>\n  strike-convert --source api  --api-key XXX --out <dir>\n  strike-convert --source auto --api-key XXX --csv <file> --out <dir>",
    );
    process.exit(2);
  }

  if (args.csvPath && !existsSync(args.csvPath)) {
    console.error(`CSV file not found: ${args.csvPath}`);
    process.exit(2);
  }
  mkdirSync(args.outDir, { recursive: true });

  const opts: IngestStrikeOptions = {
    source: args.source,
    apiKey: args.apiKey,
    csvPath: args.csvPath,
  };

  let result: IngestStrikeResult;
  try {
    result = await ingestStrike(opts);
  } catch (err) {
    console.error(`ingestStrike failed: ${(err as Error).message}`);
    process.exit(1);
  }

  const report: string[] = [];
  const log = (s: string): void => {
    console.log(s);
    report.push(s);
  };

  log(`Strike connector path: ${result.pathUsed}`);
  log(
    `Payload summary: ${result.payload.summary.journalEntries} entries / ${result.payload.summary.journalLines} lines`,
  );
  for (const w of result.warnings) log(`  warning: ${w}`);
  for (const e of result.payload.summary.errors) log(`  ERROR: ${e}`);

  writeFileSync(join(args.outDir, "staged-import.json"), JSON.stringify(result.payload, null, 2));
  log(`Wrote staged-import.json`);

  if (result.payload.staged.journalEntries?.length) {
    writeFileSync(
      join(args.outDir, "journal-entries.csv"),
      journalRowsToCsv(result.payload.staged.journalEntries),
    );
    log(`Wrote journal-entries.csv (${result.payload.staged.journalEntries.length} lines)`);
  }

  writeFileSync(
    join(args.outDir, "categorization-suggestions.json"),
    JSON.stringify(result.categorizationSuggestions, null, 2),
  );
  log(`Wrote categorization-suggestions.json (${result.categorizationSuggestions.length} groups)`);
  for (const g of result.categorizationSuggestions) {
    log(`  - ${g.count} × ${g.label} → suggested: ${g.suggestedAccountName}`);
  }

  writeFileSync(join(args.outDir, "_run-report.txt"), report.join("\n") + "\n");
  log(`Done. Report: ${join(args.outDir, "_run-report.txt")}`);
}

main();
