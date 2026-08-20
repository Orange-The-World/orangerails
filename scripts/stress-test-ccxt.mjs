/**
 * Stress test: confirm every exchange in _ccxt-manifest.ts instantiates
 * cleanly through CCXT and exposes the capabilities we declared.
 *
 * Usage: node scripts/stress-test-ccxt.mjs
 *
 * What this validates:
 *   - Every manifest entry corresponds to a real CCXT exchange id
 *   - The exchange class can be constructed
 *   - The capabilities we declared (trades / deposits / withdrawals) still
 *     match CCXT's `has` map (CCXT version drift would show up here)
 *
 * What this does NOT validate:
 *   - Real API calls (no credentials, no rate budget for 98 exchanges)
 *   - Live sync against a credentialed account (per-exchange integration
 *     test is a separate concern, lives in scripts/test-zpub-sync.mjs
 *     for xpub today)
 *
 * Exit code: 0 if all manifest entries pass, 1 if any fail.
 */

import ccxt from 'ccxt';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(__dirname, '..', 'supabase', 'functions', '_shared', 'providers', '_ccxt', 'manifest.ts');
const STATUS_PATH = join(__dirname, '..', 'docs', 'ccxt-status.md');

const tsSource = readFileSync(MANIFEST_PATH, 'utf8');
const slugMatches = [...tsSource.matchAll(/slug: "([^"]+)"/g)].map(m => m[1]);
const tradesMatches = [...tsSource.matchAll(/trades: (true|false), deposits: (true|false), withdrawals: (true|false)/g)];
if (slugMatches.length !== tradesMatches.length) {
  console.error('Could not parse manifest: slug/capabilities count mismatch');
  process.exit(1);
}

const entries = slugMatches.map((slug, i) => ({
  slug,
  trades: tradesMatches[i][1] === 'true',
  deposits: tradesMatches[i][2] === 'true',
  withdrawals: tradesMatches[i][3] === 'true',
}));

console.log('Stress-testing', entries.length, 'CCXT exchanges');
console.log('CCXT version:', ccxt.version);
console.log();

let pass = 0;
let fail = 0;
const failures = [];
const drift = [];

for (const entry of entries) {
  const ExchangeClass = ccxt[entry.slug];
  if (typeof ExchangeClass !== 'function') {
    fail++;
    failures.push({ slug: entry.slug, reason: 'not a CCXT exchange in this version' });
    continue;
  }
  let inst;
  try {
    inst = new ExchangeClass({});
  } catch (e) {
    fail++;
    failures.push({ slug: entry.slug, reason: 'constructor threw: ' + (e.message || String(e)) });
    continue;
  }
  const actual = {
    trades: !!inst.has?.fetchMyTrades,
    deposits: !!inst.has?.fetchDeposits,
    withdrawals: !!inst.has?.fetchWithdrawals,
  };
  const driftKeys = [];
  if (actual.trades !== entry.trades) driftKeys.push('trades');
  if (actual.deposits !== entry.deposits) driftKeys.push('deposits');
  if (actual.withdrawals !== entry.withdrawals) driftKeys.push('withdrawals');
  if (driftKeys.length) {
    drift.push({ slug: entry.slug, driftKeys, declared: entry, actual });
  }
  pass++;
}

console.log('Instantiation: ' + pass + '/' + entries.length + ' OK');
if (fail > 0) {
  console.log('Failures: ' + fail);
  for (const f of failures) console.log('  - ' + f.slug + ': ' + f.reason);
}
if (drift.length > 0) {
  console.log('Capability drift (manifest stale vs CCXT): ' + drift.length);
  for (const d of drift) {
    console.log('  - ' + d.slug + ': ' + d.driftKeys.join(', ') + ' (declared/actual: ' +
      d.driftKeys.map(k => `${k}=${d.declared[k]}/${d.actual[k]}`).join(', ') + ')');
  }
}

if (fail > 0 || drift.length > 0) {
  console.log();
  console.log('Action: regenerate the manifest with `node scripts/generate-ccxt-manifest.mjs`');
  process.exit(1);
}

console.log();
console.log('All ' + entries.length + ' exchanges pass.');
