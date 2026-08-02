/**
 * Generate the CCXT exchange manifest by introspecting the installed
 * `ccxt` package. Output:
 *
 *   supabase/functions/_shared/providers/_ccxt/manifest.ts   (TS module)
 *   docs/ccxt-status.md                                       (support matrix)
 *
 * Usage: node scripts/generate-ccxt-manifest.mjs
 *
 * Run this whenever you bump ccxt in package.json so the manifest and
 * the support matrix stay in sync with the installed version. The
 * stress-test script catches drift if you forget.
 *
 * Strategy: enumerate `ccxt.exchanges`, instantiate each, keep only
 * those whose `requiredCredentials` shape we already wire credential
 * fields for (apiKey+secret, apiKey+password+secret, apiKey+secret+uid).
 * Exchanges using exotic credentials (privateKey+walletAddress for DEX
 * wrappers, accountId+apiKey+secret, etc.) are skipped — they need
 * adapter changes before they can plug into makeCcxtAdapter.
 */

import ccxt from 'ccxt';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(__dirname, '..', 'supabase', 'functions', '_shared', 'providers', '_ccxt', 'manifest.ts');
const STATUS_PATH = join(__dirname, '..', 'docs', 'ccxt-status.md');

// Hand-curated popularity hints for the headline exchanges. Anything not
// in the map defaults to 35 (mid-pack). The picker sorts within-category
// by popularity DESC, so this only affects display ordering, not function.
const POPULARITY = {
  binance: 95, coinbase: 100, kraken: 95, bybit: 85, okx: 82, kucoin: 75,
  bitstamp: 70, bitfinex: 65, gemini: 75, cryptocom: 72, ndax: 55, bitbuy: 55,
  gate: 65, mexc: 60, bitget: 65, htx: 60, bingx: 55, upbit: 60, bithumb: 55,
  bitflyer: 55, coincheck: 50, luno: 50, independentreserve: 45, btcmarkets: 45,
  whitebit: 45, poloniex: 50, lbank: 45, hyperliquid: 50, hashkey: 45,
  hollaex: 40, hitbtc: 50,
};

const ALLOWED_CRED_SHAPES = new Set([
  'apiKey+secret',
  'apiKey+password+secret',
  'apiKey+secret+uid',
]);

const EU_CCS = new Set(['DE','FR','NL','IT','ES','PL','IE','MT','GB','CH','AT','BE','DK','FI','SE','NO','PT','CZ','RO','BG','EE','LT','LV']);
const ASIA_CCS = new Set(['JP','KR','SG','HK','TW','TH','ID','MY','VN','PH','IN']);

const rows = [];
const skipped = [];

for (const id of ccxt.exchanges) {
  try {
    const inst = new ccxt[id]({});
    const creds = Object.entries(inst.requiredCredentials || {})
      .filter(([, v]) => v)
      .map(([k]) => k)
      .sort()
      .join('+');
    if (!ALLOWED_CRED_SHAPES.has(creds)) {
      skipped.push({ id, reason: creds || '(none)' });
      continue;
    }
    const countries = inst.countries || [];
    const tags = ['exchange'];
    if (countries.includes('US')) tags.push('us');
    if (countries.includes('CA')) tags.push('ca');
    if (countries.some((c) => EU_CCS.has(c))) tags.push('eu');
    if (countries.some((c) => ASIA_CCS.has(c))) tags.push('asia');
    if (inst.has?.fetchDeposits || inst.has?.fetchWithdrawals) tags.push('fiat-on-ramp');
    rows.push({
      id,
      name: inst.name || id,
      countries,
      creds,
      trades: !!inst.has?.fetchMyTrades,
      deposits: !!inst.has?.fetchDeposits,
      withdrawals: !!inst.has?.fetchWithdrawals,
      fetchBalance: !!inst.has?.fetchBalance,
      popularity: POPULARITY[id] ?? 35,
      tags,
    });
  } catch {
    skipped.push({ id, reason: 'constructor threw' });
  }
}

rows.sort((a, b) => b.popularity - a.popularity || a.id.localeCompare(b.id));

const today = new Date().toISOString().slice(0, 10);

const ts = [];
ts.push('/**');
ts.push(' * GENERATED FILE, do not edit by hand.');
ts.push(' * Source: scripts/generate-ccxt-manifest.mjs introspecting ccxt@' + ccxt.version);
ts.push(' * Regenerated: ' + today);
ts.push(' * Total exchanges: ' + rows.length);
ts.push(' */');
ts.push('');
ts.push('export interface CcxtExchangeManifestEntry {');
ts.push('  slug: string;');
ts.push('  exchangeId: string;');
ts.push('  displayName: string;');
ts.push('  description?: string;');
ts.push('  tags: string[];');
ts.push('  popularity: number;');
ts.push("  credentialShape: 'apiKey+secret' | 'apiKey+password+secret' | 'apiKey+secret+uid';");
ts.push('  capabilities: { trades: boolean; deposits: boolean; withdrawals: boolean; fetchBalance: boolean };');
ts.push('}');
ts.push('');
ts.push('export const CCXT_MANIFEST: ReadonlyArray<CcxtExchangeManifestEntry> = [');
for (const r of rows) {
  const desc = r.name + (r.countries.length ? ' (' + r.countries.join(', ') + ')' : '');
  ts.push('  {');
  ts.push('    slug: ' + JSON.stringify(r.id) + ',');
  ts.push('    exchangeId: ' + JSON.stringify(r.id) + ',');
  ts.push('    displayName: ' + JSON.stringify(r.name) + ',');
  ts.push('    description: ' + JSON.stringify(desc) + ',');
  ts.push('    tags: ' + JSON.stringify(r.tags) + ',');
  ts.push('    popularity: ' + r.popularity + ',');
  ts.push('    credentialShape: ' + JSON.stringify(r.creds) + ',');
  ts.push('    capabilities: { trades: ' + r.trades + ', deposits: ' + r.deposits + ', withdrawals: ' + r.withdrawals + ', fetchBalance: ' + r.fetchBalance + ' },');
  ts.push('  },');
}
ts.push('];');
ts.push('');

writeFileSync(MANIFEST_PATH, ts.join('\n'));
console.error('Wrote ' + MANIFEST_PATH + ': ' + rows.length + ' exchanges');

const md = [];
md.push('# CCXT exchange support matrix');
md.push('');
md.push('**Generated:** ' + today + ' from `ccxt@' + ccxt.version + '` introspection.');
md.push('');
md.push('**Total wired:** ' + rows.length + " exchanges using OR's standard CCXT adapter.");
md.push('');
md.push('**Skipped:** ' + skipped.length + ' exchanges using credential shapes that need adapter changes (privateKey+walletAddress for DEX wrappers, accountId+apiKey+secret, apiKey-only sandboxes). Tracked as a Sprint 2 follow-up.');
md.push('');
md.push('Regenerate with: `node scripts/generate-ccxt-manifest.mjs`');
md.push('');
md.push('## What the matrix means');
md.push('');
md.push('Four CCXT capabilities matter to OR sync:');
md.push('');
md.push('* **trades** — `fetchMyTrades` available, OR can pull buy/sell history');
md.push('* **deposits** — `fetchDeposits` available, OR can pull funding events');
md.push('* **withdrawals** — `fetchWithdrawals` available, OR can pull payouts');
md.push('* **fetchBalance** — `fetchBalance` available, OR uses this to validate credentials on connect');
md.push('');
md.push("If `trades` is false for an exchange, sync surfaces zero transactions until CCXT adds it upstream. That's a CCXT limitation, not OR.");
md.push('');
md.push('## Matrix');
md.push('');
md.push('| Exchange | Slug | Countries | Trades | Deposits | Withdrawals | fetchBalance | Cred shape |');
md.push('|----------|------|-----------|--------|----------|-------------|--------------|------------|');
for (const r of rows) {
  md.push('| ' + r.name + ' | `' + r.id + '` | ' + (r.countries.join(', ') || '—') + ' | ' +
    (r.trades ? '✅' : '❌') + ' | ' + (r.deposits ? '✅' : '❌') + ' | ' +
    (r.withdrawals ? '✅' : '❌') + ' | ' + (r.fetchBalance ? '✅' : '❌') + ' | ' + r.creds + ' |');
}
md.push('');
if (skipped.length > 0) {
  md.push('## Skipped (need adapter changes)');
  md.push('');
  md.push('| Exchange | Cred shape required |');
  md.push('|----------|---------------------|');
  for (const s of skipped) md.push('| `' + s.id + '` | ' + s.reason + ' |');
  md.push('');
}

writeFileSync(STATUS_PATH, md.join('\n') + '\n');
console.error('Wrote ' + STATUS_PATH);

const caps = rows.reduce((a, r) => ({
  trades: a.trades + (r.trades ? 1 : 0),
  deposits: a.deposits + (r.deposits ? 1 : 0),
  withdrawals: a.withdrawals + (r.withdrawals ? 1 : 0),
  fetchBalance: a.fetchBalance + (r.fetchBalance ? 1 : 0),
}), { trades: 0, deposits: 0, withdrawals: 0, fetchBalance: 0 });
console.error('Capabilities across ' + rows.length + ' exchanges:', caps);
