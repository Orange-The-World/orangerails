#!/usr/bin/env bun
/**
 * Orange Rails , Wave Accounting → BitBooks CSV converter (CLI).
 *
 * Usage:
 *   bun run scripts/wave-convert.ts <input-dir> <output-dir>
 *
 * Expects in <input-dir>:
 *   accounts.json        (required , Wave GraphQL accounts dump)
 *   business.json        (recommended , needed for correct multi-currency JE tagging)
 *   customers.json       (optional)
 *   vendors.json         (optional)
 *   accounting.csv       (optional , Wave UI CSV export; without it no JEs are produced)
 *
 * Writes to <output-dir>:
 *   chart-of-accounts.csv
 *   contacts.csv         (when customers.json or vendors.json present)
 *   journal-entries.csv  (when accounting.csv present)
 *   staged-import.json   (StagedImportPayload , Mode 2 single-file upload)
 *   _run-report.txt      (summary of row counts, warnings, errors)
 *
 * Designed for local use on the founder's machine. Do NOT run on a shared
 * server: Wave plaintext data is sensitive (ZKA boundary).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildCoaCsv, parseWaveAccountsJson } from '../src/connectors/wave/accounts-to-coa';
import { buildContactsCsv, parseWavePartiesJson } from '../src/connectors/wave/parties-to-contacts';
import { buildJournalEntriesCsv } from '../src/connectors/wave/journal-csv-to-v3';
import { buildAccountCodeMap } from '../src/connectors/wave/code-map';
import { buildWaveStagedPayload } from '../src/connectors/wave/to-staged-payload';

function readOptional(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function main(): void {
  const [, , inputDir, outputDir] = process.argv;
  if (!inputDir || !outputDir) {
    console.error('Usage: bun run scripts/wave-convert.ts <input-dir> <output-dir>');
    process.exit(2);
  }
  if (!existsSync(inputDir)) {
    console.error(`Input dir not found: ${inputDir}`);
    process.exit(2);
  }
  mkdirSync(outputDir, { recursive: true });

  const accountsPath = join(inputDir, 'accounts.json');
  if (!existsSync(accountsPath)) {
    console.error(`Required file missing: ${accountsPath}`);
    process.exit(2);
  }
  const accounts = parseWaveAccountsJson(readFileSync(accountsPath, 'utf8'));
  const codeMap = buildAccountCodeMap(accounts);

  // Business currency from business.json (Wave dumps amounts in this even
  // for foreign-currency accounts). Falls back to most common account
  // currency in accounts.json, then USD.
  let businessCurrency: string | undefined;
  const bizPath = join(inputDir, 'business.json');
  if (existsSync(bizPath)) {
    try {
      const biz = JSON.parse(readFileSync(bizPath, 'utf8'));
      businessCurrency = biz?.business?.currency?.code;
    } catch {
      /* ignore parse errors; fall through to derivation */
    }
  }
  if (!businessCurrency) {
    const tally: Record<string, number> = {};
    for (const a of accounts) {
      const c = a.currency?.code ?? 'USD';
      tally[c] = (tally[c] ?? 0) + 1;
    }
    businessCurrency = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'USD';
  }

  const report: string[] = [];
  const log = (s: string): void => {
    console.log(s);
    report.push(s);
  };

  log(`Loaded ${accounts.length} Wave accounts from ${accountsPath}`);
  log(`Business currency: ${businessCurrency}${existsSync(bizPath) ? ' (from business.json)' : ' (derived from accounts.json majority)'}`);

  // 1. Chart of Accounts
  const coa = buildCoaCsv(accounts, codeMap);
  writeFileSync(join(outputDir, 'chart-of-accounts.csv'), coa.csv);
  log(`Wrote chart-of-accounts.csv (${coa.rowCount} rows)`);
  for (const w of coa.warnings) log(`  warning: ${w}`);

  // 2. Contacts
  const custRaw = readOptional(join(inputDir, 'customers.json'));
  const vendRaw = readOptional(join(inputDir, 'vendors.json'));
  if (custRaw || vendRaw) {
    const customers = custRaw ? parseWavePartiesJson(custRaw) : [];
    const vendors = vendRaw ? parseWavePartiesJson(vendRaw) : [];
    const contacts = buildContactsCsv(customers, vendors);
    writeFileSync(join(outputDir, 'contacts.csv'), contacts.csv);
    log(
      `Wrote contacts.csv (${contacts.rowCount} rows: ${customers.length} customers, ${vendors.length} vendors)`,
    );
    for (const w of contacts.warnings) log(`  warning: ${w}`);
  } else {
    log('Skipped contacts.csv (no customers.json or vendors.json)');
  }

  // 3. Journal Entries
  const jeCsvRaw = readOptional(join(inputDir, 'accounting.csv'));
  if (jeCsvRaw) {
    const je = buildJournalEntriesCsv(jeCsvRaw, codeMap, accounts, { businessCurrency });
    writeFileSync(join(outputDir, 'journal-entries.csv'), je.csv);
    log(`Wrote journal-entries.csv (${je.groupCount} entries, ${je.lineCount} lines)`);
    for (const w of je.warnings) log(`  warning: ${w}`);
    for (const e of je.errors) log(`  ERROR: ${e}`);
  } else {
    log(
      'Skipped journal-entries.csv (no accounting.csv in input dir , export from Wave UI and drop it in).',
    );
  }

  // 4. Mode 2 staged payload (single JSON file for "Import from Orange Rails" wizard)
  const customersForPayload = custRaw ? parseWavePartiesJson(custRaw) : undefined;
  const vendorsForPayload = vendRaw ? parseWavePartiesJson(vendRaw) : undefined;
  const files: Array<{ name: string; sizeBytes: number; bytes?: Uint8Array }> = [];
  for (const fname of ['accounts.json', 'customers.json', 'vendors.json', 'accounting.csv']) {
    const fpath = join(inputDir, fname);
    if (existsSync(fpath)) {
      const buf = readFileSync(fpath);
      files.push({ name: fname, sizeBytes: buf.length, bytes: new Uint8Array(buf) });
    }
  }
  const { payload } = buildWaveStagedPayload({
    accounts,
    customers: customersForPayload,
    vendors: vendorsForPayload,
    accountingCsvText: jeCsvRaw ?? undefined,
    businessCurrency,
    files,
  });
  writeFileSync(join(outputDir, 'staged-import.json'), JSON.stringify(payload, null, 2));
  log(
    `Wrote staged-import.json (Mode 2): ${payload.summary.accounts} accounts, ${payload.summary.contacts} contacts, ${payload.summary.journalEntries} JEs / ${payload.summary.journalLines} lines`,
  );
  for (const e of payload.summary.errors) log(`  ERROR: ${e}`);

  writeFileSync(join(outputDir, '_run-report.txt'), report.join('\n') + '\n');
  log(`Done. Report: ${join(outputDir, '_run-report.txt')}`);
}

main();
