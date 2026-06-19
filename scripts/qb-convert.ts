#!/usr/bin/env bun
/**
 * Orange Rails , QuickBooks → V3 staged-import.json CLI.
 *
 * Usage:
 *   bun run scripts/qb-convert.ts <input.zip> <output-dir> [--currency=USD]
 *
 * Input: a QuickBooks export zip (multiple .xlsx files inside) OR a
 * directory containing the .xlsx files individually.
 *
 * Output: <output-dir>/staged-import.json , upload through V3's
 * "Import from Orange Rails" wizard.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

import {
  buildQuickBooksStagedPayload,
  parseQuickBooksZip,
  type QuickBooksStagingFile,
} from '../src/connectors/quickbooks';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const input = args[0];
  const outputDir = args[1];
  const currencyArg = args.find((a) => a.startsWith('--currency='));
  const businessCurrency = currencyArg ? currencyArg.split('=')[1] : 'USD';

  if (!input || !outputDir) {
    console.error('Usage: bun run scripts/qb-convert.ts <input.zip|dir> <output-dir> [--currency=USD]');
    process.exit(2);
  }
  if (!existsSync(input)) {
    console.error(`Input not found: ${input}`);
    process.exit(2);
  }
  mkdirSync(outputDir, { recursive: true });

  const stat = statSync(input);
  let files: QuickBooksStagingFile[];
  if (stat.isDirectory()) {
    const names = readdirSync(input).filter((n) => /\.xlsx$/i.test(n));
    files = names.map((name) => ({
      name,
      bytes: new Uint8Array(readFileSync(join(input, name))),
    }));
  } else {
    const zipBytes = new Uint8Array(readFileSync(input));
    files = await parseQuickBooksZip(zipBytes);
  }

  console.log(`Loaded ${files.length} QuickBooks file(s) from ${basename(input)}`);
  console.log(`Business currency: ${businessCurrency}`);

  const { payload, errors } = await buildQuickBooksStagedPayload({ files, businessCurrency });

  writeFileSync(join(outputDir, 'staged-import.json'), JSON.stringify(payload, null, 2));

  console.log(`Wrote staged-import.json:`);
  console.log(`  accounts:        ${payload.summary.accounts}`);
  console.log(`  contacts:        ${payload.summary.contacts}`);
  console.log(`  journal entries: ${payload.summary.journalEntries}`);
  console.log(`  journal lines:   ${payload.summary.journalLines}`);
  for (const w of payload.summary.warnings) console.log(`  warning: ${w}`);
  for (const e of errors) console.log(`  ERROR: ${e}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
