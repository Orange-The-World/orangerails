#!/usr/bin/env node
/**
 * CCXT per-exchange stress-test harness.
 *
 * Validates that a real API key can connect to each CCXT exchange
 * that OR wires via its standard adapter. Hit every exchange whose
 * credentials appear in CCXT_TEST_CREDS and report green or red.
 *
 * Usage:
 *   CCXT_TEST_CREDS='{"kraken":{"apiKey":"...","secret":"..."}}' \
 *     node scripts/ccxt-stress.mjs
 *
 * CCXT_TEST_CREDS is a JSON object keyed by CCXT exchange id. Each value
 * must supply the credential fields the exchange requires:
 *   apiKey + secret             (most exchanges: binance, kraken, gemini, ...)
 *   apiKey + secret + password  (coinbase, okx, kucoin, ...)
 *   apiKey + secret + uid       (bitstamp)
 *
 * Only exchanges that OR already wires via its standard adapter are tested.
 * Exchanges using exotic credential shapes (DEX wallets, account-id-based
 * auth) are outside OR scope and reported as SKIP.
 *
 * Exit code: 0 when every credentialed exchange returns green, 1 otherwise.
 * Exchanges without credentials are skipped and do not affect the exit code.
 *
 * discoverWallets note: the CCXT adapter's discoverWallets is a synthetic
 * no-op by design (browser-origin CORS blocks direct exchange API calls
 * from the OR widget). Real credential validation happens on first sync.
 * This harness exercises that same path via fetchBalance, which hits the
 * same auth endpoint as trades, deposits, and withdrawals.
 */

import ccxt from 'ccxt';

const TIMEOUT_MS = 15_000;

// Mirrors the ALLOWED_CRED_SHAPES set in generate-ccxt-manifest.mjs and
// in supabase/functions/_shared/providers/_ccxt/index.ts. Only exchanges
// matching one of these shapes are wired into OR's standard CCXT adapter.
const ALLOWED_CRED_SHAPES = new Set([
  'apiKey+secret',
  'apiKey+password+secret',
  'apiKey+secret+uid',
]);

// ---- Parse credentials from environment ---------------------------------

let TEST_CREDS;
try {
  TEST_CREDS = JSON.parse(process.env.CCXT_TEST_CREDS ?? '{}');
} catch {
  console.error('Error: CCXT_TEST_CREDS must be valid JSON.');
  console.error("  Example: CCXT_TEST_CREDS='{\"kraken\":{\"apiKey\":\"x\",\"secret\":\"y\"}}'");
  process.exit(1);
}

if (!TEST_CREDS || typeof TEST_CREDS !== 'object' || Array.isArray(TEST_CREDS)) {
  console.error('Error: CCXT_TEST_CREDS must be a JSON object keyed by exchange id.');
  process.exit(1);
}

// ---- Build OR-wired exchange list (mirrors generate-ccxt-manifest.mjs) --

console.log(`ccxt@${ccxt.version}: enumerating OR-wired exchanges...`);
const wiredExchanges = [];
for (const id of ccxt.exchanges) {
  try {
    const inst = new ccxt[id]({});
    const credShape = Object.entries(inst.requiredCredentials ?? {})
      .filter(([, v]) => v)
      .map(([k]) => k)
      .sort()
      .join('+');
    if (ALLOWED_CRED_SHAPES.has(credShape)) {
      wiredExchanges.push({ id, credShape });
    }
  } catch {
    // Constructor threw; exchange is not usable. Skip.
  }
}
console.log(`Found ${wiredExchanges.length} OR-wired exchanges.\n`);

// ---- Run tests ----------------------------------------------------------

const results = [];
let credentialedCount = 0;
let greenCount = 0;
let redCount = 0;

for (const { id, credShape } of wiredExchanges) {
  const creds = TEST_CREDS[id];
  if (!creds || typeof creds !== 'object') {
    results.push({ id, status: 'skip', credShape, ms: null, error: null });
    continue;
  }

  credentialedCount++;
  const start = Date.now();
  try {
    const ExchangeClass = ccxt[id];
    const exchange = new ExchangeClass({
      ...creds,
      enableRateLimit: true,
    });

    // fetchBalance is the lightest credentialed call: it hits the exchange
    // account API and proves the key and secret (and passphrase/uid where
    // required) are accepted. All three OR data streams (trades, deposits,
    // withdrawals) go through the same auth path, so a green here means
    // sync will reach the exchange.
    await Promise.race([
      exchange.fetchBalance(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`timed out after ${TIMEOUT_MS}ms`)),
          TIMEOUT_MS,
        ),
      ),
    ]);

    const ms = Date.now() - start;
    results.push({ id, status: 'green', credShape, ms, error: null });
    greenCount++;
    console.log(`GREEN  ${id.padEnd(28)} ${String(ms).padStart(6)}ms  (${credShape})`);
  } catch (err) {
    const ms = Date.now() - start;
    const error = err instanceof Error ? err.message : String(err);
    results.push({ id, status: 'red', credShape, ms, error });
    redCount++;
    console.log(`RED    ${id.padEnd(28)} ${String(ms).padStart(6)}ms  ${error.slice(0, 80)}`);
  }
}

// ---- Summary ------------------------------------------------------------

const skipped = results.filter((r) => r.status === 'skip').length;

console.log('');
console.log('-'.repeat(72));
console.log(`OR-wired exchanges (ccxt@${ccxt.version}): ${String(wiredExchanges.length).padStart(4)}`);
console.log(`Credentialed accounts supplied:          ${String(credentialedCount).padStart(4)}`);
console.log(`Green:                                   ${String(greenCount).padStart(4)}`);
console.log(`Red:                                     ${String(redCount).padStart(4)}`);
console.log(`Skipped (no credentials):                ${String(skipped).padStart(4)}`);

if (redCount > 0) {
  console.log('');
  console.log('Red exchanges:');
  for (const r of results.filter((r) => r.status === 'red')) {
    console.log(`  ${r.id}: ${r.error}`);
  }
}

if (credentialedCount === 0) {
  console.log('');
  console.log('No credentials supplied. All exchanges skipped.');
  console.log("Supply CCXT_TEST_CREDS to run live tests:");
  console.log("  CCXT_TEST_CREDS='{\"kraken\":{\"apiKey\":\"...\",\"secret\":\"...\"}}' node scripts/ccxt-stress.mjs");
}

process.exit(redCount > 0 ? 1 : 0);
