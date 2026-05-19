#!/usr/bin/env bun
/**
 * Wave Trial Balance penny match.
 *
 * Reads:
 *   accounts.json — Wave's reported balance per account (point-in-time)
 *   staged-import.json — the converter's output
 *
 * Computes the V3 balance per account from the staged JE lines:
 *   For DEBIT-normal accounts:  Σ(debit) − Σ(credit)
 *   For CREDIT-normal accounts: Σ(credit) − Σ(debit)
 *
 * Compares to Wave's `balance` field. Prints per-account diff. Any non-zero
 * diff is a discrepancy.
 *
 * Usage:
 *   bun run scripts/penny-match.ts <input-dir> <output-dir>
 *
 * Caveats:
 *   - Wave's `balance` is point-in-time as of when the API dump was taken.
 *     If the founder added transactions AFTER the dump but BEFORE the CSV
 *     export, the staged total will exceed Wave's reported balance.
 *   - "Transfer Clearing" and similar duplicated-name accounts pick the
 *     first match — multiple Wave accounts with the same name end up as
 *     one V3 account. Reported balances should sum, not diverge.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unwrapNodes, type WaveAccountNode } from '../src/connectors/wave/types';
import type { StagedImportPayload } from '../src/connectors/contract';

const [, , inputDir, outputDir] = process.argv;
if (!inputDir || !outputDir) {
  console.error('Usage: bun run scripts/penny-match.ts <input-dir> <output-dir>');
  process.exit(2);
}

const accounts = unwrapNodes<WaveAccountNode>(
  JSON.parse(readFileSync(join(inputDir, 'accounts.json'), 'utf8')),
);
const payload: StagedImportPayload = JSON.parse(
  readFileSync(join(outputDir, 'staged-import.json'), 'utf8'),
);

// Sum Wave-reported balance per name (CASE-FOLD; many duplicates exist).
const waveByName = new Map<string, { balance: number; normal: 'DEBIT' | 'CREDIT'; currency: string }>();
for (const a of accounts) {
  const k = a.name.trim().toLowerCase();
  const bal = Number.parseFloat(a.balance ?? '0') || 0;
  const existing = waveByName.get(k);
  if (existing) existing.balance += bal;
  else
    waveByName.set(k, {
      balance: bal,
      normal: a.type.normalBalanceType,
      currency: a.currency?.code ?? 'USD',
    });
}

// Sum staged JE lines per account name.
const stagedByName = new Map<string, { debit: number; credit: number }>();
for (const row of payload.staged.journalEntries ?? []) {
  const name = (row.account_name ?? '').trim().toLowerCase();
  if (!name) continue;
  const entry = stagedByName.get(name) ?? { debit: 0, credit: 0 };
  entry.debit += Number.parseFloat(row.debit || '0') || 0;
  entry.credit += Number.parseFloat(row.credit || '0') || 0;
  stagedByName.set(name, entry);
}

// Compare.
type Diff = { name: string; wave: number; v3: number; diff: number; currency: string };
const diffs: Diff[] = [];
let inWaveNotStaged = 0;
let inStagedNotWave = 0;

for (const [name, wave] of waveByName) {
  const s = stagedByName.get(name);
  if (!s) {
    if (Math.round(wave.balance * 100) !== 0) inWaveNotStaged += 1;
    continue;
  }
  const computed = wave.normal === 'DEBIT' ? s.debit - s.credit : s.credit - s.debit;
  const diff = Math.round((computed - wave.balance) * 100) / 100;
  if (diff !== 0) {
    diffs.push({
      name: [...waveByName.keys()].find((k) => k === name) ?? name,
      wave: Math.round(wave.balance * 100) / 100,
      v3: Math.round(computed * 100) / 100,
      diff,
      currency: wave.currency,
    });
  }
}
for (const [name] of stagedByName) {
  if (!waveByName.has(name)) inStagedNotWave += 1;
}

diffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

console.log(`Wave accounts referenced in CSV: ${stagedByName.size}`);
console.log(`Accounts with non-zero balance in Wave that have no JE lines: ${inWaveNotStaged}`);
console.log(`Account names in CSV that don't exist in accounts.json: ${inStagedNotWave}`);
console.log(`Accounts where V3 ≠ Wave: ${diffs.length}`);
if (diffs.length === 0) {
  console.log('\n✅ PENNY MATCH: every account matches Wave to the cent.');
} else {
  console.log(`\n${diffs.length} mismatches (largest first):\n`);
  console.log('Account                                                    | Currency | Wave        | V3-computed | Diff');
  console.log('-'.repeat(120));
  for (const d of diffs.slice(0, 40)) {
    console.log(
      `${d.name.padEnd(58)} | ${d.currency.padEnd(8)} | ${d.wave.toFixed(2).padStart(11)} | ${d.v3.toFixed(2).padStart(11)} | ${d.diff.toFixed(2).padStart(8)}`,
    );
  }
  if (diffs.length > 40) console.log(`... and ${diffs.length - 40} more.`);
  const sumDiff = diffs.reduce((s, d) => s + d.diff, 0);
  console.log(`\nSum of all diffs: ${sumDiff.toFixed(2)} (should be ~0 if discrepancies cancel out)`);
}
