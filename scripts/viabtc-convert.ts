#!/usr/bin/env bun
/**
 * Orange Rails, ViaBTC pool → BitBooks converter (CLI).
 *
 * Usage:
 *   bun run scripts/viabtc-convert.ts --api-key XXX --secret-key YYY --out <out-dir>
 *   bun run scripts/viabtc-convert.ts --api-key XXX --secret-key YYY --since 2024-01-01 --out <out-dir>
 *
 * Outputs to <out-dir>:
 *   staged-import.json  , StagedImportPayload (Mode 2)
 *   journal-entries.csv , per-section CSV (when JE rows present)
 *   _run-report.txt     , counts, warnings, errors
 *
 * Local-only: ViaBTC plaintext data is sensitive (ZKA boundary). Do NOT run
 * on a shared server. Credentials are read from flags or env (VIABTC_API_KEY,
 * VIABTC_SECRET_KEY) so they do not have to sit in the shell history.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ingestViaBtc, ViaBtcAuthError, type IngestViaBtcResult } from "../src/connectors/viabtc";

type Args = {
  apiKey: string;
  secretKey: string;
  outDir: string;
  since?: string;
  until?: string;
};

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {};
  let i = 2;
  while (i < argv.length) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case "--api-key":
        out.apiKey = next;
        i += 2;
        break;
      case "--secret-key":
        out.secretKey = next;
        i += 2;
        break;
      case "--since":
        out.since = next;
        i += 2;
        break;
      case "--until":
        out.until = next;
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
  out.apiKey = out.apiKey ?? process.env.VIABTC_API_KEY;
  out.secretKey = out.secretKey ?? process.env.VIABTC_SECRET_KEY;
  if (!out.apiKey) throw new Error("--api-key (or VIABTC_API_KEY) is required");
  if (!out.secretKey) throw new Error("--secret-key (or VIABTC_SECRET_KEY) is required");
  if (!out.outDir) throw new Error("--out is required");
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
      "Usage:\n  viabtc-convert --api-key XXX --secret-key YYY --out <dir>\n  viabtc-convert --api-key XXX --secret-key YYY --since 2024-01-01 --out <dir>",
    );
    process.exit(2);
  }

  mkdirSync(args.outDir, { recursive: true });

  let result: IngestViaBtcResult;
  try {
    result = await ingestViaBtc({
      apiKey: args.apiKey,
      secretKey: args.secretKey,
      since: args.since,
      until: args.until,
    });
  } catch (err) {
    if (err instanceof ViaBtcAuthError) {
      console.error(`ViaBTC authentication failed: ${(err as Error).message}`);
      process.exit(1);
    }
    console.error(`ingestViaBtc failed: ${(err as Error).message}`);
    process.exit(1);
  }

  const report: string[] = [];
  const log = (s: string): void => {
    console.log(s);
    report.push(s);
  };

  log(`ViaBTC connector path: ${result.pathUsed}`);
  log(
    `Payload summary: ${result.payload.summary.journalEntries} entries / ${result.payload.summary.journalLines} lines`,
  );
  log(
    `Raw history: ${result.history.payments.length} payouts, ${result.history.profits.length} profit days, ${result.history.rewards.length} reward days`,
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

  writeFileSync(join(args.outDir, "_run-report.txt"), report.join("\n") + "\n");
  log(`Done. Report: ${join(args.outDir, "_run-report.txt")}`);
}

main();
