/**
 * Stealth Sync end-to-end CLI test.
 *
 * Runs the production runSync orchestrator against the live filter producer
 * and block source with a real-world Bitcoin extended key. Validates that
 * the same code path the customer widget uses returns sensible numbers
 * before rollout.
 *
 * Inputs come from environment variables, never command-line arguments,
 * so the extended key never lands in a shell history file:
 *   STEALTH_TEST_INPUT     bare xpub/ypub/zpub or output descriptor
 *   STEALTH_TEST_BIRTHDAY  ISO date, e.g. 2025-11-05
 *
 * The script generates a fresh in-memory AES key, seals a wallet payload
 * under it, and feeds the envelope to runSync. The key never leaves
 * memory; nothing is written to disk.
 */

import {
  runSync,
  liveFetchTip,
  liveFetchFilter,
  liveFetchBlock,
  liveResolveBirthdayHeight,
  type SyncProgressEvent,
} from '../src/stealth/lib/sync';
import { parseDescriptor, type ScriptType } from '../src/stealth/lib/derive';
import { sealEnvelope } from '../src/stealth/lib/seal';

// ─── Setup ──────────────────────────────────────────────────────────────

const INPUT = process.env.STEALTH_TEST_INPUT;
const BIRTHDAY = process.env.STEALTH_TEST_BIRTHDAY;

if (!INPUT) {
  console.error('Error: set STEALTH_TEST_INPUT to a bare xpub/ypub/zpub or output descriptor.');
  process.exit(2);
}
if (!BIRTHDAY) {
  console.error('Error: set STEALTH_TEST_BIRTHDAY to an ISO date such as 2025-11-05.');
  process.exit(2);
}

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return Buffer.from(s, 'binary').toString('base64');
}

function fmtSats(sats: number): string {
  const btc = (sats / 1e8).toFixed(8);
  return `${sats.toLocaleString('en-US')} sats (${btc} BTC)`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  console.log('Stealth Sync live test starting.');
  console.log(`  Wallet birthday: ${BIRTHDAY}`);

  // Parse the input. We accept bare extended keys plus the descriptor
  // shapes parseDescriptor supports.
  const parsed = parseDescriptor(INPUT!);
  if (parsed.kind === 'multisig') {
    // Out of scope for this customer; bail with a clear message.
    console.error('Multisig descriptors are not supported by this test script yet.');
    process.exit(2);
  }
  const key0 = parsed.keys[0];
  console.log(`  Detected script type: ${key0.scriptType}`);

  // Generate a throwaway 32-byte stealth key. Lives in this process only.
  const stealthKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  const orStealthKey = bytesToB64(stealthKeyBytes);

  // Build the wallet payload the orchestrator expects, then seal it.
  const walletPayload = {
    kind: 'xpub_stealth' as const,
    xpub: key0.xpub,
    label: 'live-test',
    wallet_birthday: BIRTHDAY!,
    gap_limit: 20,
    script_type: key0.scriptType as ScriptType,
  };
  const envelope = await sealEnvelope(walletPayload, orStealthKey);

  // Resolve the wallet birthday to a starting block height via the live
  // block source (with the built-in date approximation as fallback).
  const birthdayHeight = await liveResolveBirthdayHeight(BIRTHDAY!);
  console.log(`  Birthday resolves to height: ${birthdayHeight}`);

  // Progress pump. Print one line per stage transition plus periodic
  // updates inside long stages.
  let lastStage = '';
  let lastPctLogged = -100;
  const onProgress = (ev: SyncProgressEvent) => {
    const stageChanged = ev.stage !== lastStage;
    const pctJump = Math.abs(ev.percent - lastPctLogged) >= 10;
    if (stageChanged || pctJump || ev.percent === 100) {
      const pct = ev.percent.toString().padStart(3, ' ');
      const detail = ev.detail ? ` ${ev.detail}` : '';
      console.log(`  [${ev.stage}] ${pct}% ${ev.message}.${detail}`);
      lastStage = ev.stage;
      lastPctLogged = ev.percent;
    }
  };

  const startedAt = Date.now();
  const result = await runSync({
    envelope,
    orStealthKey,
    birthdayHeight,
    fetchTip: () => liveFetchTip(),
    fetchFilter: (h) => liveFetchFilter(h),
    fetchBlock: (h) => liveFetchBlock(h),
    onProgress,
  });
  const elapsedSec = (Date.now() - startedAt) / 1000;

  // ── Summary ──────────────────────────────────────────────────────────
  const txs = result.normalized;
  const totalSats = txs.reduce((acc, t) => acc + t.amount_sats, 0);
  const heights = txs.map((t) => t.block_height);
  const lowest = heights.length ? Math.min(...heights) : null;
  const highest = heights.length ? Math.max(...heights) : null;
  const uniqueAddresses = new Set(txs.map((t) => t.address).filter(Boolean));
  const txids = txs.map((t) => t.txid);
  const firstFive = txids.slice(0, 5);
  const lastFive = txids.slice(Math.max(0, txids.length - 5));

  console.log('');
  console.log('────────── Summary ──────────');
  console.log(`Total transactions found:    ${txs.length}`);
  console.log(`Total satoshis received:     ${fmtSats(totalSats)}`);
  console.log(`Lowest block height:         ${lowest ?? 'n/a'}`);
  console.log(`Highest block height:        ${highest ?? 'n/a'}`);
  console.log(`Unique addresses with txs:   ${uniqueAddresses.size}`);
  console.log(`Bytes downloaded:            ${fmtBytes(result.bytesDownloaded)}`);
  console.log(`Last block scanned (tip):    ${result.lastBlockScanned}`);
  console.log(`Wall-clock seconds:          ${elapsedSec.toFixed(2)}`);
  console.log('');
  if (firstFive.length) {
    console.log('First 5 txids:');
    for (const t of firstFive) console.log(`  ${t}`);
  }
  if (lastFive.length && txs.length > 5) {
    console.log('Last 5 txids:');
    for (const t of lastFive) console.log(`  ${t}`);
  }
  console.log('────────── Done ──────────');
}

main().catch((err) => {
  console.error('Sync failed:', err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
