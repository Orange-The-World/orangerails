/**
 * Stealth Sync , sync orchestrator end-to-end tests.
 *
 * The tests exercise `runSync` against fixture filters, fixture blocks,
 * a stub BIP158 matcher, and a sealed envelope produced from a known
 * BIP84 test-vector xpub. The goals are:
 *
 *   1. Verify the orchestrator emits all eight PROGRESS stages in order.
 *   2. Verify the final SealedTransaction array round-trips through the
 *      seal helpers back to the expected NormalizedTransaction shape.
 *   3. Verify the txid_blind_index_hex is derived from the txid (not
 *      something else) so the server can dedup on retry.
 *
 * We avoid loading the WASM matcher in node-vitest by injecting a custom
 * matcher into RunSyncOptions. The matcher returns true for a fixture
 * filter and false otherwise, which keeps the test deterministic and
 * offline.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';

import { sealEnvelope, unsealEnvelope } from './seal';
import {
  CONFIRMATION_DEPTH,
  FILTER_FETCH_ATTEMPTS,
  liveFetchBlock,
  liveFetchFilter,
  liveFetchTip,
  liveResolveBirthdayHeight,
  runSync,
  type BlockRecord,
  type WalletEnvelopePayload,
} from './sync';
import { deriveAddress, deriveScriptPubkeyBytes } from './derive';
import type { StealthStage } from './postmessage';

// BIP84 official test vector (https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki).
const BIP84_XPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

function randomKeyB64(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (let i = 0; i < raw.length; i++) s += String.fromCharCode(raw[i]);
  return btoa(s);
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function u32LE(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = n & 0xff; b[1] = (n >>> 8) & 0xff; b[2] = (n >>> 16) & 0xff; b[3] = (n >>> 24) & 0xff;
  return b;
}

function u64LE(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    b[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return b;
}

function varInt(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) {
    const b = new Uint8Array(3);
    b[0] = 0xfd; b[1] = n & 0xff; b[2] = (n >>> 8) & 0xff;
    return b;
  }
  // u32 path is sufficient for fixtures.
  const b = new Uint8Array(5);
  b[0] = 0xfe;
  b[1] = n & 0xff;
  b[2] = (n >>> 8) & 0xff;
  b[3] = (n >>> 16) & 0xff;
  b[4] = (n >>> 24) & 0xff;
  return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** One input of a fixture transaction: a genuine previous outpoint. */
interface FixtureTxInput {
  /** Previous txid in RPC display order, which is what parseTx reports. */
  prevTxidHex: string;
  voutIdx: number;
}

/** One output of a fixture transaction. */
interface FixtureTxOutput {
  script: Uint8Array;
  amountSats: bigint;
}

interface FixtureTx {
  /**
   * Omit for the all-zero outpoint the single-output fixtures have always
   * used. parseTx drops that input as coinbase-like, which is correct and
   * is exactly why a spend test has to supply real outpoints here.
   */
  inputs?: FixtureTxInput[];
  outputs: FixtureTxOutput[];
}

/**
 * Serialize one legacy (non-witness) transaction.
 *
 * Layout:
 *   [version=2 LE 4][vin count varint]
 *   [per input: outpoint 36 + scriptSig 0 + seq 0xffffffff]
 *   [vout count varint][per output: value 8 LE + scriptPubKey varint+bytes]
 *   [locktime 4]
 *
 * Because there is no witness, this serialization IS the pre-image the
 * orchestrator hashes for the txid, so fixtureTxid below can hash it
 * directly and get the same value parseTx will report.
 */
function serializeFixtureTx(tx: FixtureTx): Uint8Array {
  const inputs: FixtureTxInput[] = tx.inputs ?? [
    { prevTxidHex: '00'.repeat(32), voutIdx: 0xffffffff },
  ];

  const parts: Uint8Array[] = [
    u32LE(2),                 // version
    varInt(inputs.length),    // vin count
  ];
  for (const inp of inputs) {
    // On the wire the previous txid is internal little-endian; parseTx
    // reverses it back to display order. Write it reversed here so the
    // caller can pass the txid string the orchestrator hands back.
    parts.push(reverseBytes(hexToBytes(inp.prevTxidHex)));
    parts.push(u32LE(inp.voutIdx));
    parts.push(varInt(0));            // empty scriptSig
    parts.push(u32LE(0xffffffff));    // sequence
  }

  parts.push(varInt(tx.outputs.length));
  for (const out of tx.outputs) {
    parts.push(u64LE(out.amountSats));
    parts.push(varInt(out.script.length));
    parts.push(out.script);
  }
  parts.push(u32LE(0));               // locktime

  return concat(...parts);
}

/**
 * Build a minimal valid block.
 *
 * Two call shapes:
 *   { payToScript, amountSats, timestamp }  one transaction, one
 *     coinbase-like input, one output. The original shape; every existing
 *     call site produces byte-identical blocks.
 *   { txs, timestamp }                      any number of transactions,
 *     each with real previous outpoints and any number of outputs. This is
 *     what makes a spend expressible.
 *
 * Layout:
 *   [80-byte header][varint(txCount)][tx...]
 *
 * Header timestamp is bytes 68..72.
 *
 * Returns the serialized bytes of each transaction alongside the block so
 * the caller can derive txids for use as inputs in a later block.
 */
function buildFixtureBlock(opts: {
  payToScript?: Uint8Array;
  amountSats?: bigint;
  timestamp: number;
  txs?: FixtureTx[];
}): { raw: Uint8Array; blockHashHex: string; txs: Uint8Array[] } {
  // Header: version + prev hash + merkle + ts + bits + nonce. We do not
  // bother making the merkle root match (the orchestrator does not verify);
  // for txid we hash the legacy serialization independently.
  const header = new Uint8Array(80);
  header.set(u32LE(0x20000000), 0);   // version
  // prev hash zeros, merkle zeros (left as-is)
  header.set(u32LE(opts.timestamp), 68);
  header.set(u32LE(0x1d00ffff), 72);   // bits
  header.set(u32LE(0), 76);            // nonce

  let txList: FixtureTx[];
  if (opts.txs !== undefined) {
    txList = opts.txs;
  } else {
    if (opts.payToScript === undefined || opts.amountSats === undefined) {
      // Loud rather than quietly building an empty block: a fixture that
      // silently contains nothing would make an assertion pass for the
      // wrong reason.
      throw new Error(
        'buildFixtureBlock: pass either txs, or payToScript together with amountSats',
      );
    }
    txList = [{ outputs: [{ script: opts.payToScript, amountSats: opts.amountSats }] }];
  }

  const serialized = txList.map(serializeFixtureTx);
  const raw = concat(header, varInt(serialized.length), ...serialized);

  // We do NOT compute the real block hash from the header double-sha256
  // here; the orchestrator's parseBlockHeader does that itself. We need
  // the matching hash for the fetchBlock callback to look it up. Compute
  // it inline using SubtleCrypto.
  // Vitest's node env has globalThis.crypto.subtle.digest with SHA-256.
  // But for synchronous fixture creation we use a tiny inline routine.
  return { raw, blockHashHex: '' /* filled in by caller using async sha */, txs: serialized };
}

/**
 * The txid the orchestrator will report for a fixture transaction. These
 * fixtures carry no witness, so the whole serialization is the legacy
 * serialization parseTx hashes.
 */
async function fixtureTxid(txBytes: Uint8Array): Promise<string> {
  return bytesToHex(reverseBytes(await dsha256Async(txBytes)));
}

async function dsha256Async(b: Uint8Array): Promise<Uint8Array> {
  const a = await crypto.subtle.digest('SHA-256', b as unknown as ArrayBuffer);
  const c = await crypto.subtle.digest('SHA-256', a);
  return new Uint8Array(c);
}

function reverseBytes(b: Uint8Array): Uint8Array {
  const o = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) o[i] = b[b.length - 1 - i];
  return o;
}

describe('runSync , orchestrator end-to-end with fixtures', () => {
  it('walks all eight PROGRESS stages in order and returns sealed transactions', async () => {
    const orStealthKey = randomKeyB64();

    // 1. Seal an envelope with the BIP84 test-vector xpub.
    const payload: WalletEnvelopePayload = {
      kind: 'xpub_stealth',
      xpub: BIP84_XPUB,
      label: 'Sparrow main (BIP84 vector)',
      wallet_birthday: '2021-01-15',
      gap_limit: 5,
      script_type: 'p2wpkh',
    };
    const envelope = await sealEnvelope(payload, orStealthKey);

    // 2. Derive the user's first receive scriptPubKey to point a fixture
    //    block at it.
    const targetScript = deriveScriptPubkeyBytes(BIP84_XPUB, 0, 0, 'p2wpkh');

    // 3. Build a fixture block paying 12,345 sats to that script.
    const fixtureTimestamp = Math.floor(new Date('2024-06-01T12:00:00Z').getTime() / 1000);
    const blockBuild = buildFixtureBlock({
      payToScript: targetScript,
      amountSats: 12_345n,
      timestamp: fixtureTimestamp,
    });
    const blockHash = reverseBytes(await dsha256Async(blockBuild.raw.subarray(0, 80)));
    const blockHashHex = bytesToHex(blockHash);

    // 4. Build a fake filter (any non-empty bytes) for the matcher to
    //    "match" against. The custom matcher below returns true for this
    //    filter+blockHash pair only.
    const fakeFilter = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

    // 5. Stage emission tracker.
    const stagesSeen: StealthStage[] = [];

    const result = await runSync({
      envelope,
      orStealthKey,
      birthdayHeight: 700_000,
      lastBlockScanned: 700_000,
      fetchTip: async () => 700_001 + CONFIRMATION_DEPTH,
      fetchFilter: async (h) => {
        if (h === 700_001) {
          return { height: h, blockHashHex, filter: fakeFilter };
        }
        return null;
      },
      fetchBlock: async (h) => {
        expect(h).toBe(blockHashHex);
        return { height: 700_001, blockHashHex, raw: blockBuild.raw };
      },
      matcher: {
        matchAny: (filter, hash, scripts) => {
          // The orchestrator passes the hash in internal-LE order. Our
          // fixture block hash was computed dsha256(header), then we stored
          // it in display (reverse) order. The orchestrator reverses it
          // back before passing to the matcher; verify both sides line up.
          expect(filter).toEqual(fakeFilter);
          expect(bytesToHex(hash)).toBe(bytesToHex(reverseBytes(blockHash)));
          // We expect the user's scripts to be present.
          const found = scripts.some(
            (s) =>
              s.length === targetScript.length &&
              s.every((b, i) => b === targetScript[i]),
          );
          expect(found).toBe(true);
          return true;
        },
      },
      onProgress: (ev) => {
        if (stagesSeen[stagesSeen.length - 1] !== ev.stage) {
          stagesSeen.push(ev.stage);
        }
      },
    });

    // ── Assertions ────────────────────────────────────────────────────
    expect(stagesSeen).toEqual([
      'unlocking',
      'deriving',
      'fetching_filters',
      'matching',
      'fetching_blocks',
      'building_txs',
      'sealing',
      'uploading',
    ]);

    expect(result.txCount).toBe(1);
    expect(result.sealedTransactions).toHaveLength(1);
    expect(result.normalized).toHaveLength(1);

    const tx = result.normalized[0];
    expect(tx.amount_sats).toBe(12_345);
    expect(tx.direction).toBe('in');
    expect(tx.block_height).toBe(700_001);
    expect(tx.occurred_at).toBe('2024-06-01');
    expect(tx.txid).toMatch(/^[0-9a-f]{64}$/);

    // The sealed transaction round-trips back to the same plaintext.
    const sealed = result.sealedTransactions[0];
    expect(sealed.occurred_at).toBe('2024-06-01');
    expect(sealed.block_height).toBe(700_001);
    expect(sealed.txid_blind_index_hex).toMatch(/^[0-9a-f]{64}$/);
    expect(sealed).not.toHaveProperty('txid_blind_index_b64');
    const decrypted = await unsealEnvelope<typeof tx>(sealed, orStealthKey);
    expect(decrypted).toEqual(tx);
  });

  it('short-circuits when lastBlockScanned is above tip, returns stored cursor not tip', async () => {
    const orStealthKey = randomKeyB64();
    const payload: WalletEnvelopePayload = {
      kind: 'xpub_stealth',
      xpub: BIP84_XPUB,
      label: 'Up to date',
      wallet_birthday: '2024-01-01',
      gap_limit: 2,
      script_type: 'p2wpkh',
    };
    const envelope = await sealEnvelope(payload, orStealthKey);

    let filterCalled = false;
    let blockCalled = false;
    const stagesSeen: StealthStage[] = [];

    const result = await runSync({
      envelope,
      orStealthKey,
      birthdayHeight: 800_000,
      lastBlockScanned: 800_600,
      fetchTip: async () => 800_500,
      fetchFilter: async () => {
        filterCalled = true;
        return null;
      },
      fetchBlock: async () => {
        blockCalled = true;
        throw new Error('should not be called');
      },
      matcher: { matchAny: () => false },
      onProgress: (ev) => {
        if (stagesSeen[stagesSeen.length - 1] !== ev.stage) {
          stagesSeen.push(ev.stage);
        }
      },
    });

    expect(filterCalled).toBe(false);
    expect(blockCalled).toBe(false);
    expect(result.txCount).toBe(0);
    expect(result.sealedTransactions).toEqual([]);
    expect(result.lastBlockScanned).toBe(800_600);
    // We still emit all stages so the modal can finish gracefully.
    expect(stagesSeen).toEqual([
      'unlocking',
      'deriving',
      'fetching_filters',
      'matching',
      'fetching_blocks',
      'building_txs',
      'sealing',
      'uploading',
    ]);
  });

  it('stops cursor before first null-filter block, not at tip (DL-0516)', async () => {
    // Blocks 800_000-800_004 return a valid non-matching filter; 800_005+
    // return null (CDN gap). The cursor must land at 800_004, not tip
    // (800_010), so the next sync retries the gap from 800_005.
    const orStealthKey = randomKeyB64();
    const payload: WalletEnvelopePayload = {
      kind: 'xpub_stealth',
      xpub: BIP84_XPUB,
      label: 'null-filter-cursor',
      wallet_birthday: '2024-01-01',
      gap_limit: 2,
      script_type: 'p2wpkh',
    };
    const envelope = await sealEnvelope(payload, orStealthKey);

    const result = await runSync({
      envelope,
      orStealthKey,
      birthdayHeight: 800_000,
      lastBlockScanned: null,
      fetchTip: async () => 800_010 + CONFIRMATION_DEPTH,
      fetchFilter: async (h) => {
        if (h >= 800_005) return null;
        return { height: h, blockHashHex: '00'.repeat(32), filter: new Uint8Array(0) };
      },
      fetchBlock: async () => { throw new Error('should not be called'); },
      matcher: { matchAny: () => false },
    });

    expect(result.lastBlockScanned).toBe(800_004);
    expect(result.txCount).toBe(0);
  });

  // Condition 4 of issue #335: birthdayHeight outside [0, tip] must REJECT,
  // never clamp. Clamping would silently claim a scan range the user never
  // requested and is not recoverable; rejection is.
  it('rejects when birthdayHeight exceeds tip (does not clamp to tip)', async () => {
    const orStealthKey = randomKeyB64();
    const payload: WalletEnvelopePayload = {
      kind: 'xpub_stealth',
      xpub: BIP84_XPUB,
      label: 'birthday-above-tip',
      wallet_birthday: '2024-01-01',
      gap_limit: 2,
      script_type: 'p2wpkh',
    };
    const envelope = await sealEnvelope(payload, orStealthKey);

    await expect(
      runSync({
        envelope,
        orStealthKey,
        birthdayHeight: 800_001,
        lastBlockScanned: null,
        fetchTip: async () => 800_000,
        fetchFilter: async () => { throw new Error('must not reach filter fetch'); },
        fetchBlock: async () => { throw new Error('must not reach block fetch'); },
        matcher: { matchAny: () => false },
      }),
    ).rejects.toThrow(/out of range/);
  });

  it('rejects when birthdayHeight is negative (does not clamp to 0)', async () => {
    const orStealthKey = randomKeyB64();
    const payload: WalletEnvelopePayload = {
      kind: 'xpub_stealth',
      xpub: BIP84_XPUB,
      label: 'birthday-negative',
      wallet_birthday: '2024-01-01',
      gap_limit: 2,
      script_type: 'p2wpkh',
    };
    const envelope = await sealEnvelope(payload, orStealthKey);

    await expect(
      runSync({
        envelope,
        orStealthKey,
        birthdayHeight: -1,
        lastBlockScanned: null,
        fetchTip: async () => 800_000,
        fetchFilter: async () => { throw new Error('must not reach filter fetch'); },
        fetchBlock: async () => { throw new Error('must not reach block fetch'); },
        matcher: { matchAny: () => false },
      }),
    ).rejects.toThrow(/out of range/);
  });

  it('rejects when fetchBlock rejects, does not silently advance lastBlockScanned (DL-0629)', async () => {
    const orStealthKey = randomKeyB64();
    const payload: WalletEnvelopePayload = {
      kind: 'xpub_stealth',
      xpub: BIP84_XPUB,
      label: 'fetchBlock-rejection',
      wallet_birthday: '2024-01-01',
      gap_limit: 2,
      script_type: 'p2wpkh',
    };
    const envelope = await sealEnvelope(payload, orStealthKey);

    await expect(
      runSync({
        envelope,
        orStealthKey,
        birthdayHeight: 850_000,
        lastBlockScanned: 850_000,
        fetchTip: async () => 850_001 + CONFIRMATION_DEPTH,
        fetchFilter: async (h) => ({
          height: h,
          blockHashHex: 'ab'.repeat(32),
          filter: new Uint8Array([1, 2, 3]),
        }),
        fetchBlock: async () => {
          throw new Error('block-fetch-network-error');
        },
        matcher: { matchAny: () => true },
      }),
    ).rejects.toThrow('block-fetch-network-error');
  });

  it('skips transactions whose outputs do not pay any of our scripts', async () => {
    const orStealthKey = randomKeyB64();
    const payload: WalletEnvelopePayload = {
      kind: 'xpub_stealth',
      xpub: BIP84_XPUB,
      label: 'Negative case',
      wallet_birthday: '2024-01-01',
      gap_limit: 3,
      script_type: 'p2wpkh',
    };
    const envelope = await sealEnvelope(payload, orStealthKey);

    // Pay to a scriptPubKey we did NOT derive (random P2WPKH).
    const unrelated = new Uint8Array(22);
    unrelated[0] = 0x00; // OP_0
    unrelated[1] = 0x14; // push 20 bytes
    crypto.getRandomValues(unrelated.subarray(2));

    const blockBuild = buildFixtureBlock({
      payToScript: unrelated,
      amountSats: 99n,
      timestamp: Math.floor(new Date('2024-08-01T00:00:00Z').getTime() / 1000),
    });
    const blockHash = reverseBytes(await dsha256Async(blockBuild.raw.subarray(0, 80)));
    const blockHashHex = bytesToHex(blockHash);

    const result = await runSync({
      envelope,
      orStealthKey,
      birthdayHeight: 850_000,
      lastBlockScanned: 850_000,
      fetchTip: async () => 850_001 + CONFIRMATION_DEPTH,
      fetchFilter: async (h) => {
        if (h === 850_001) {
          return { height: h, blockHashHex, filter: new Uint8Array([1, 2, 3]) };
        }
        return null;
      },
      fetchBlock: async () => ({
        height: 850_001,
        blockHashHex,
        raw: blockBuild.raw,
      }),
      // Force a filter "match" even though the block does not actually pay
      // us; this is the BIP158 false-positive case the orchestrator must
      // tolerate.
      matcher: { matchAny: () => true },
    });

    expect(result.txCount).toBe(0);
    expect(result.sealedTransactions).toEqual([]);
    // Bytes downloaded still tracks both filter and block.
    expect(result.bytesDownloaded).toBeGreaterThan(0);
  });

  // ── Window exhaustion detection (issue #352) ────────────────────────────

  it('windowExhausted is true when a match lands at or above the exhaustion threshold', async () => {
    // gap_limit=3 => windowSize=6 => threshold = windowSize - gapLimit = 3.
    // A match at receive chain index 3 is exactly at the threshold; the flag must fire.
    const orStealthKey = randomKeyB64();
    const payload: WalletEnvelopePayload = {
      kind: 'xpub_stealth',
      xpub: BIP84_XPUB,
      label: 'exhaustion-true',
      wallet_birthday: '2024-01-01',
      gap_limit: 3,
      script_type: 'p2wpkh',
    };
    const envelope = await sealEnvelope(payload, orStealthKey);

    // Derive address at chain=0, index=3 (receive chain, index at threshold).
    const targetScript = deriveScriptPubkeyBytes(BIP84_XPUB, 0, 3, 'p2wpkh');
    const ts = Math.floor(new Date('2024-07-01T00:00:00Z').getTime() / 1000);
    const blockBuild = buildFixtureBlock({ payToScript: targetScript, amountSats: 10_000n, timestamp: ts });
    const blockHash = reverseBytes(await dsha256Async(blockBuild.raw.subarray(0, 80)));
    const blockHashHex = bytesToHex(blockHash);
    const fakeFilter = new Uint8Array([0xaa]);

    const result = await runSync({
      envelope,
      orStealthKey,
      birthdayHeight: 900_000,
      lastBlockScanned: 900_000,
      fetchTip: async () => 900_001 + CONFIRMATION_DEPTH,
      fetchFilter: async (h) =>
        h === 900_001 ? { height: h, blockHashHex, filter: fakeFilter } : null,
      fetchBlock: async () => ({ height: 900_001, blockHashHex, raw: blockBuild.raw }),
      matcher: { matchAny: () => true },
    });

    expect(result.txCount).toBe(1);
    expect(result.windowExhausted).toBe(true);
  });

  it('windowExhausted is false when all matches are well below the exhaustion threshold', async () => {
    // gap_limit=5 => windowSize=10 => threshold = 5.
    // A match at receive chain index 0 is far below the threshold; no flag.
    const orStealthKey = randomKeyB64();
    const payload: WalletEnvelopePayload = {
      kind: 'xpub_stealth',
      xpub: BIP84_XPUB,
      label: 'exhaustion-false',
      wallet_birthday: '2024-01-01',
      gap_limit: 5,
      script_type: 'p2wpkh',
    };
    const envelope = await sealEnvelope(payload, orStealthKey);

    // Derive address at chain=0, index=0 (receive chain, index far from threshold).
    const targetScript = deriveScriptPubkeyBytes(BIP84_XPUB, 0, 0, 'p2wpkh');
    const ts = Math.floor(new Date('2024-07-02T00:00:00Z').getTime() / 1000);
    const blockBuild = buildFixtureBlock({ payToScript: targetScript, amountSats: 5_000n, timestamp: ts });
    const blockHash = reverseBytes(await dsha256Async(blockBuild.raw.subarray(0, 80)));
    const blockHashHex = bytesToHex(blockHash);
    const fakeFilter = new Uint8Array([0xbb]);

    const result = await runSync({
      envelope,
      orStealthKey,
      birthdayHeight: 910_000,
      lastBlockScanned: 910_000,
      fetchTip: async () => 910_001 + CONFIRMATION_DEPTH,
      fetchFilter: async (h) =>
        h === 910_001 ? { height: h, blockHashHex, filter: fakeFilter } : null,
      fetchBlock: async () => ({ height: 910_001, blockHashHex, raw: blockBuild.raw }),
      matcher: { matchAny: () => true },
    });

    expect(result.txCount).toBe(1);
    expect(result.windowExhausted).toBe(false);
  });

  it('seals extension transactions: sealedTransactions includes txs found in rolling-window passes', async () => {
    // Scenario: gap_limit=2, so initial chainWindowEnd=[4,4] (indices 0..3 per chain).
    // Block A (height 800_001) pays to index 3 on chain 0: near-edge (3 >= 4-2=2),
    // so the extension loop fires. Block B (height 800_002) pays to index 4 on chain 0,
    // which falls in the first extension window (indices 4,5). After the fix, both txs
    // must appear in sealedTransactions. Before the fix, the sealing loop ran BEFORE
    // the extension loop, so sealedTransactions had 1 entry while txCount reported 2.
    const orStealthKey = randomKeyB64();
    const payload: WalletEnvelopePayload = {
      kind: 'xpub_stealth',
      xpub: BIP84_XPUB,
      label: 'extension-sealing',
      wallet_birthday: '2024-01-01',
      gap_limit: 2,
      script_type: 'p2wpkh',
    };
    const envelope = await sealEnvelope(payload, orStealthKey);

    const scriptIdx3 = deriveScriptPubkeyBytes(BIP84_XPUB, 0, 3, 'p2wpkh');
    const scriptIdx4 = deriveScriptPubkeyBytes(BIP84_XPUB, 0, 4, 'p2wpkh');

    const tsA = Math.floor(new Date('2024-08-01T10:00:00Z').getTime() / 1000);
    const tsB = Math.floor(new Date('2024-08-02T10:00:00Z').getTime() / 1000);
    const blockA = buildFixtureBlock({ payToScript: scriptIdx3, amountSats: 12_345n, timestamp: tsA });
    const blockB = buildFixtureBlock({ payToScript: scriptIdx4, amountSats: 6_789n, timestamp: tsB });

    const hashHexA = bytesToHex(reverseBytes(await dsha256Async(blockA.raw.subarray(0, 80))));
    const hashHexB = bytesToHex(reverseBytes(await dsha256Async(blockB.raw.subarray(0, 80))));

    // Filters are distinguishable by first byte so the stub matcher can respond
    // per-block without a WASM GCS implementation.
    const filterA = new Uint8Array([0xa1]);
    const filterB = new Uint8Array([0xa2]);

    const result = await runSync({
      envelope,
      orStealthKey,
      birthdayHeight: 800_000,
      lastBlockScanned: 800_000,
      fetchTip: async () => 800_002 + CONFIRMATION_DEPTH,
      fetchFilter: async (h) => {
        if (h === 800_001) return { height: h, blockHashHex: hashHexA, filter: filterA };
        if (h === 800_002) return { height: h, blockHashHex: hashHexB, filter: filterB };
        return null;
      },
      fetchBlock: async (hashHex) => {
        if (hashHex === hashHexA) return { height: 0, blockHashHex: hashHexA, raw: blockA.raw };
        if (hashHex === hashHexB) return { height: 0, blockHashHex: hashHexB, raw: blockB.raw };
        throw new Error(`unexpected block hash ${hashHex}`);
      },
      // Reads filter[0] to identify the block, then checks if the target script is
      // present in the scripts list. Simulates GCS semantics without WASM.
      //   filterA (block A, pays idx3): matches when idx3 is in scripts (initial pass only).
      //   filterB (block B, pays idx4): matches when idx4 is in scripts (extension pass 1 only).
      matcher: {
        matchAny: (filter, _hash, scripts) => {
          const target = filter[0] === 0xa1 ? scriptIdx3
            : filter[0] === 0xa2 ? scriptIdx4
            : null;
          if (!target) return false;
          return scripts.some((s) => s.length === target.length && s.every((b, i) => b === target[i]));
        },
      },
    });

    // Both transactions must be present in normalized.
    expect(result.txCount).toBe(2);
    expect(result.normalized).toHaveLength(2);

    // KEY: sealedTransactions must also have 2 entries including the extension tx.
    expect(result.sealedTransactions).toHaveLength(2);

    // The extension tx (idx4, 6789 sats) must round-trip through unsealing.
    const extNormalized = result.normalized.find((t) => t.amount_sats === 6_789);
    expect(extNormalized).toBeDefined();
    const extSealed = result.sealedTransactions.find((s) => s.occurred_at === '2024-08-02');
    expect(extSealed).toBeDefined();
    const decrypted = await unsealEnvelope<typeof extNormalized>(extSealed!, orStealthKey);
    expect(decrypted!.amount_sats).toBe(6_789);
    expect(decrypted!.direction).toBe('in');

    // Extension fired, so the flag must be set.
    expect(result.windowExhausted).toBe(true);
  });

  it('extension passes re-match cached filters without calling fetchFilter again (req 4)', async () => {
    // Regression guard for the filter-cache fix (#353 req 4): when extension
    // fires because activity lands near the window edge, the orchestrator must
    // re-match filter bytes from the initial scan cache, NOT re-download them.
    // A redundant network call per height per extension pass would multiply
    // bandwidth by up to MAX_WINDOW_PASSES (10), which is the defect this
    // test guards against.
    const orStealthKey = randomKeyB64();
    const payload: WalletEnvelopePayload = {
      kind: 'xpub_stealth',
      xpub: BIP84_XPUB,
      label: 'filter-cache-req4',
      wallet_birthday: '2024-01-01',
      // gap_limit=1: initial window covers indices [0, 1]; match at index 1
      // is within gapLimit=1 of the edge (chainWindowEnd=2), so one
      // extension pass fires.
      gap_limit: 1,
      script_type: 'p2wpkh',
    };
    const envelope = await sealEnvelope(payload, orStealthKey);

    const scriptIdx1 = deriveScriptPubkeyBytes(BIP84_XPUB, 0, 1, 'p2wpkh');
    const ts = Math.floor(new Date('2024-06-01T00:00:00Z').getTime() / 1000);
    const blockBuild = buildFixtureBlock({
      payToScript: scriptIdx1,
      amountSats: 1_000n,
      timestamp: ts,
    });
    const blockHashHex = bytesToHex(reverseBytes(await dsha256Async(blockBuild.raw.subarray(0, 80))));
    const fakeFilter = new Uint8Array([0xc1]);

    const fetchFilterCalls: number[] = [];
    const result = await runSync({
      envelope,
      orStealthKey,
      birthdayHeight: 800_000,
      lastBlockScanned: 800_000,
      fetchTip: async () => 800_001 + CONFIRMATION_DEPTH,
      fetchFilter: async (h) => {
        fetchFilterCalls.push(h);
        if (h === 800_001) return { height: h, blockHashHex, filter: fakeFilter };
        return null;
      },
      fetchBlock: async () => ({ height: 0, blockHashHex, raw: blockBuild.raw }),
      // Matches filter 0xc1 only when scriptIdx1 is in the scripts list.
      // The extension pass uses passNewScripts (idx2 only), so no new hits
      // are found and the loop terminates after one extension pass.
      matcher: {
        matchAny: (filter, _hash, scripts) => {
          if (filter[0] !== 0xc1) return false;
          return scripts.some((s) => s.length === scriptIdx1.length && s.every((b, i) => b === scriptIdx1[i]));
        },
      },
    });

    expect(result.txCount).toBe(1);
    expect(result.windowExhausted).toBe(true);

    // KEY: fetchFilter must be called exactly once (initial scan only).
    // If the extension pass bypassed the cache, height 800_001 would appear
    // twice in fetchFilterCalls, revealing the defect.
    expect(fetchFilterCalls).toEqual([800_001]);
  });

  it('returns filterFetchError when fetchFilter throws rather than rejecting or silently skipping the height', async () => {
    // RED -> GREEN guard for DL-0489, updated for DL-1175.
    //
    // Before DL-0489: liveFetchFilter returned null on 404, the orchestrator
    // stored the null in filterCache and moved on -- all transactions at that
    // height were silently dropped with zero signal to the caller.
    //
    // After DL-0489: liveFetchFilter throws, the error propagated through
    // the worker's Promise.all, and runSync rejected.
    //
    // After DL-1175: the scan worker catches the fetch error, aborts the scan
    // window, and returns a resolved result with filterFetchError set. The
    // caller receives a non-zero signal and can persist the resume cursor
    // without losing it to an unhandled rejection.
    const orStealthKey = randomKeyB64();
    const payload: WalletEnvelopePayload = {
      kind: 'xpub_stealth',
      xpub: BIP84_XPUB,
      label: 'fetchfilter-404-guard',
      wallet_birthday: '2024-01-01',
      gap_limit: 3,
      script_type: 'p2wpkh',
    };
    const envelope = await sealEnvelope(payload, orStealthKey);

    const fetchFilterError = new Error(
      'liveFetchFilter: 404 at height 900001 -- filter should exist for all heights up to tip; ' +
      'this is a fetch failure, not an empty result. Do not silently skip this height.',
    );

    const result = await runSync({
      envelope,
      orStealthKey,
      birthdayHeight: 900_000,
      lastBlockScanned: 900_000,
      fetchTip: async () => 900_001 + CONFIRMATION_DEPTH,
      // Simulate liveFetchFilter throwing on 404 for the only height in range.
      fetchFilter: async (_h) => { throw fetchFilterError; },
      fetchBlock: async () => { throw new Error('should not be reached'); },
      matcher: { matchAny: () => true },
    });

    // The scan aborts gracefully: no transactions, cursor unchanged, error surfaced.
    expect(result.filterFetchError).toBeDefined();
    expect(result.filterFetchError!.failedHeight).toBe(900_001);
    expect(result.filterFetchError!.cause).toContain('liveFetchFilter: 404 at height 900001');
    expect(result.txCount).toBe(0);
    expect(result.lastBlockScanned).toBe(900_000);
  });

  it('throws when extension passes are exhausted and window is still near its edge', async () => {
    // gap_limit=1 means chainWindowEnd starts at [2, 2]; near-edge threshold
    // is index >= windowEnd - 1 on each chain.
    //
    // height 900_001: pays to chain=0 index=1 (at threshold 1 >= 2-1=1).
    //   Triggers extension pass 0: chain 0 extends from [2, 2] to [3, 2].
    // height 900_002: pays to chain=0 index=2 (the extension-window address).
    //   Extension pass 0 finds this match, window still near edge (2 >= 3-1=2).
    // maxWindowPasses=1: windowPass reaches 1 == MAX_WINDOW_PASSES, loop exits.
    // Loud-fail check fires: chain0StillNear is true -> throw.
    const orStealthKey = randomKeyB64();
    const payload: WalletEnvelopePayload = {
      kind: 'xpub_stealth',
      xpub: BIP84_XPUB,
      label: 'loud-fail',
      wallet_birthday: '2024-01-01',
      gap_limit: 1,
      script_type: 'p2wpkh',
    };
    const envelope = await sealEnvelope(payload, orStealthKey);

    const ts = Math.floor(new Date('2024-07-01T00:00:00Z').getTime() / 1000);

    // Block paying to chain=0, index=1 (triggers initial near-edge).
    const script1 = deriveScriptPubkeyBytes(BIP84_XPUB, 0, 1, 'p2wpkh');
    const block1 = buildFixtureBlock({ payToScript: script1, amountSats: 1_000n, timestamp: ts });
    const hash1Hex = bytesToHex(reverseBytes(await dsha256Async(block1.raw.subarray(0, 80))));

    // Block paying to chain=0, index=2 (the extension-window address).
    const script2 = deriveScriptPubkeyBytes(BIP84_XPUB, 0, 2, 'p2wpkh');
    const block2 = buildFixtureBlock({ payToScript: script2, amountSats: 1_000n, timestamp: ts + 600 });
    const hash2Hex = bytesToHex(reverseBytes(await dsha256Async(block2.raw.subarray(0, 80))));

    const fakeFilter = new Uint8Array([0xdd]);

    await expect(
      runSync({
        envelope,
        orStealthKey,
        birthdayHeight: 900_001,
        lastBlockScanned: null,
        fetchTip: async () => 900_002 + CONFIRMATION_DEPTH,
        fetchFilter: async (h) => {
          if (h === 900_001) return { height: h, blockHashHex: hash1Hex, filter: fakeFilter };
          if (h === 900_002) return { height: h, blockHashHex: hash2Hex, filter: fakeFilter };
          return null;
        },
        fetchBlock: async (hashHex) => {
          if (hashHex === hash1Hex) return { height: 900_001, blockHashHex: hash1Hex, raw: block1.raw };
          if (hashHex === hash2Hex) return { height: 900_002, blockHashHex: hash2Hex, raw: block2.raw };
          throw new Error(`unexpected block hash ${hashHex}`);
        },
        matcher: { matchAny: () => true },
        maxWindowPasses: 1,
      }),
    ).rejects.toThrow(/address window exhausted/);
  });
});

// ─── Live fetcher unit tests ────────────────────────────────────────────
//
// These cover the Milestone 4 wiring against the production filter
// producer and block source. We mock globalThis.fetch so the tests run
// fully offline. The interesting case is liveFetchFilter: the producer
// serves <height>.gcs.gz with Content-Type application/gzip and NO
// Content-Encoding, so the browser will not auto-decompress; the lib
// runs the body through DecompressionStream('gzip') itself.

describe('runSync height source and block ordering regressions', () => {
  // Regression pair:
  //  1. block_height must come from the FILTER match, not the block
  //     record. Browsers hide X-Block-Height unless the block source
  //     exposes it via Access-Control-Expose-Headers, so the block
  //     record height can arrive as 0.
  //  2. The concurrent filter fetch pushes hits in COMPLETION order.
  //     Blocks must be processed by ascending height or the UTXO spend
  //     tracker misses spends whose funding block was processed later.
  it('uses the filter-derived height even when the block record height is 0', async () => {
    const orStealthKey = randomKeyB64();
    const payload: WalletEnvelopePayload = {
      kind: 'xpub_stealth',
      xpub: BIP84_XPUB,
      label: 'height regression',
      wallet_birthday: '2021-01-15',
      gap_limit: 5,
      script_type: 'p2wpkh',
    };
    const envelope = await sealEnvelope(payload, orStealthKey);
    const targetScript = deriveScriptPubkeyBytes(BIP84_XPUB, 0, 0, 'p2wpkh');
    const ts = Math.floor(new Date('2024-06-01T12:00:00Z').getTime() / 1000);
    const blockBuild = buildFixtureBlock({
      payToScript: targetScript,
      amountSats: 1_000n,
      timestamp: ts,
    });
    const blockHash = reverseBytes(await dsha256Async(blockBuild.raw.subarray(0, 80)));
    const blockHashHex = bytesToHex(blockHash);
    const fakeFilter = new Uint8Array([0x01]);

    const result = await runSync({
      envelope,
      orStealthKey,
      birthdayHeight: 700_000,
      lastBlockScanned: 700_000,
      fetchTip: async () => 700_001 + CONFIRMATION_DEPTH,
      fetchFilter: async (h) =>
        h === 700_001 ? { height: h, blockHashHex, filter: fakeFilter } : null,
      // Simulate the browser CORS reality: the block record carries
      // height 0 because the header was invisible to the client.
      fetchBlock: async () => ({ height: 0, blockHashHex, raw: blockBuild.raw }),
      matcher: { matchAny: () => true },
    });

    expect(result.normalized).toHaveLength(1);
    expect(result.normalized[0].block_height).toBe(700_001);
    expect(result.sealedTransactions[0].block_height).toBe(700_001);
  });

  it('processes matched blocks by ascending height even when filters resolve out of order', async () => {
    const orStealthKey = randomKeyB64();
    const payload: WalletEnvelopePayload = {
      kind: 'xpub_stealth',
      xpub: BIP84_XPUB,
      label: 'order regression',
      wallet_birthday: '2021-01-15',
      gap_limit: 5,
      script_type: 'p2wpkh',
    };
    const envelope = await sealEnvelope(payload, orStealthKey);
    const targetScript = deriveScriptPubkeyBytes(BIP84_XPUB, 0, 0, 'p2wpkh');

    const tsLow = Math.floor(new Date('2024-06-01T12:00:00Z').getTime() / 1000);
    const tsHigh = Math.floor(new Date('2024-06-02T12:00:00Z').getTime() / 1000);
    const lowBuild = buildFixtureBlock({
      payToScript: targetScript,
      amountSats: 1_000n,
      timestamp: tsLow,
    });
    const highBuild = buildFixtureBlock({
      payToScript: targetScript,
      amountSats: 2_000n,
      timestamp: tsHigh,
    });
    const lowHash = bytesToHex(reverseBytes(await dsha256Async(lowBuild.raw.subarray(0, 80))));
    const highHash = bytesToHex(reverseBytes(await dsha256Async(highBuild.raw.subarray(0, 80))));
    const fakeFilter = new Uint8Array([0x01]);

    const fetchedOrder: string[] = [];
    const result = await runSync({
      envelope,
      orStealthKey,
      birthdayHeight: 700_000,
      lastBlockScanned: 700_000,
      fetchTip: async () => 700_002 + CONFIRMATION_DEPTH,
      // The LOWER height resolves LAST (40ms delay), so completion order
      // is high-then-low. Without the ascending sort, the low block
      // would be processed second.
      fetchFilter: async (h) => {
        if (h === 700_001) {
          await new Promise((r) => setTimeout(r, 40));
          return { height: h, blockHashHex: lowHash, filter: fakeFilter };
        }
        if (h === 700_002) {
          return { height: h, blockHashHex: highHash, filter: fakeFilter };
        }
        return null;
      },
      fetchBlock: async (h) => {
        fetchedOrder.push(h);
        if (h === lowHash) return { height: 0, blockHashHex: lowHash, raw: lowBuild.raw };
        return { height: 0, blockHashHex: highHash, raw: highBuild.raw };
      },
      matcher: { matchAny: () => true },
    });

    // Blocks fetched and processed low-height first, regardless of
    // filter completion order.
    expect(fetchedOrder).toEqual([lowHash, highHash]);
    expect(result.normalized.map((t) => t.block_height)).toEqual([700_001, 700_002]);
  });
});

describe('live fetchers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) },
    });
  }

  it('liveFetchTip parses the tip JSON', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://blocks.example/tip');
      return jsonResponse({ height: 950_000, hash: 'abcd', time: 1 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tip = await liveFetchTip('https://blocks.example');
    expect(tip).toBe(950_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('liveFetchFilter gunzips the .gcs.gz body and pulls block hash from the .json sidecar', async () => {
    const filterPayload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03]);
    const gz = gzipSync(filterPayload);
    const sidecar = {
      block_hash: '000000000000000000015c92fa872e387085585ac046e0935fdf9eed872f9297',
      block_height: 948_026,
      time: 1_777_986_476,
      filter_size: filterPayload.length,
    };

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/948026.gcs.gz')) {
        return new Response(new Uint8Array(gz) as BodyInit, {
          status: 200,
          // Caddy sets application/gzip but NOT Content-Encoding, which is
          // exactly the case our gunzip path is designed to handle.
          headers: { 'Content-Type': 'application/gzip' },
        });
      }
      if (url.endsWith('/948026.json')) {
        return jsonResponse(sidecar);
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const rec = await liveFetchFilter(948_026, 'https://stealth.example');
    expect(rec).not.toBeNull();
    expect(rec!.height).toBe(948_026);
    expect(rec!.blockHashHex).toBe(sidecar.block_hash);
    expect(Array.from(rec!.filter)).toEqual(Array.from(filterPayload));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('liveFetchFilter rejects with a fetch-failure error on 404 from either resource', async () => {
    // A 404 from the filter CDN is a fetch failure, not "no data at this
    // height". liveFetchFilter must throw so the orchestrator cannot silently
    // skip the height and drop its transactions.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('.gcs.gz')) {
        return new Response('', { status: 404 });
      }
      return jsonResponse({});
    }));

    await expect(liveFetchFilter(1, 'https://stealth.example')).rejects.toThrow(
      'liveFetchFilter: 404 at height 1',
    );
  });

  it('liveFetchFilter rejects when the sidecar JSON returns 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('.json')) {
        return new Response('', { status: 404 });
      }
      return new Response(new Uint8Array([0x1f, 0x8b]) as BodyInit, { status: 200 });
    }));

    await expect(liveFetchFilter(2, 'https://stealth.example')).rejects.toThrow(
      'liveFetchFilter: 404 at height 2',
    );
  });

  // DL-1171. A first scan of a year-old wallet issues tens of thousands of
  // filter reads through 32 concurrent workers joined with Promise.all. One
  // unretried rejection aborted the whole scan and, because the cursor is only
  // written after that join, threw away everything already read. Measured on
  // production 2026-08-18: 28,625 filters read, then a burst of network-layer
  // rejections, then "Sync failed Failed to fetch" with no progress kept.
  it('liveFetchFilter retries a network-layer rejection and succeeds on a later attempt', async () => {
    const filterPayload = new Uint8Array([0x01, 0x02, 0x03]);
    const gz = gzipSync(filterPayload);
    const sidecar = {
      block_hash: '000000000000000000015c92fa872e387085585ac046e0935fdf9eed872f9297',
      block_height: 924_821,
      time: 1_777_986_476,
      filter_size: filterPayload.length,
    };

    // Reject the whole first pair the way the browser does: a TypeError, not a
    // response. That is precisely what the status checks could never see.
    let pairsServed = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('.gcs.gz')) pairsServed += 1;
      if (pairsServed <= 1) throw new TypeError('Failed to fetch');
      if (url.endsWith('.gcs.gz')) {
        return new Response(new Uint8Array(gz) as BodyInit, { status: 200 });
      }
      return jsonResponse(sidecar);
    });
    vi.stubGlobal('fetch', fetchMock);

    const rec = await liveFetchFilter(924_821, 'https://stealth.example');
    expect(rec.height).toBe(924_821);
    expect(Array.from(rec.filter)).toEqual(Array.from(filterPayload));
    // Two pairs: the rejected one and the one that worked.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('liveFetchFilter gives up after FILTER_FETCH_ATTEMPTS and says so', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(liveFetchFilter(924_822, 'https://stealth.example')).rejects.toThrow(
      `fetchFilter 924822 failed after ${FILTER_FETCH_ATTEMPTS} attempts`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(FILTER_FETCH_ATTEMPTS * 2);
  });

  it('liveFetchFilter does not retry a 404, which stays a loud one-shot failure', async () => {
    // Retrying a 404 would turn a signal the orchestrator must see into a
    // three-times-slower version of the same failure.
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('.gcs.gz') ? new Response('', { status: 404 }) : jsonResponse({}),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(liveFetchFilter(3, 'https://stealth.example')).rejects.toThrow(
      'liveFetchFilter: 404 at height 3',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('liveFetchFilter retries a 503 but not a 403', async () => {
    const flaky = vi.fn(async (url: string) => {
      if (url.endsWith('.gcs.gz')) return new Response('', { status: 503 });
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', flaky);
    await expect(liveFetchFilter(4, 'https://stealth.example')).rejects.toThrow(
      `fetchFilter 4 failed after ${FILTER_FETCH_ATTEMPTS} attempts`,
    );
    expect(flaky).toHaveBeenCalledTimes(FILTER_FETCH_ATTEMPTS * 2);

    const forbidden = vi.fn(async (url: string) => {
      if (url.endsWith('.gcs.gz')) return new Response('', { status: 403 });
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', forbidden);
    await expect(liveFetchFilter(5, 'https://stealth.example')).rejects.toThrow(
      'fetchFilter 5 gz failed: 403',
    );
    expect(forbidden).toHaveBeenCalledTimes(2);
  });

  it('liveFetchBlock reads the X-Block-Height header', async () => {
    const raw = new Uint8Array([1, 2, 3, 4, 5]);
    const hash = '000000000000000000015c92fa872e387085585ac046e0935fdf9eed872f9297';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toBe(`https://blocks.example/block/${hash}`);
      return new Response(raw as BodyInit, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Block-Hash': hash,
          'X-Block-Height': '948026',
        },
      });
    }));

    const rec = await liveFetchBlock(hash, 'https://blocks.example');
    expect(rec.height).toBe(948_026);
    expect(rec.blockHashHex).toBe(hash);
    expect(Array.from(rec.raw)).toEqual([1, 2, 3, 4, 5]);
  });

  it('liveResolveBirthdayHeight uses the live endpoint when it succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toBe('https://blocks.example/height?date=2024-01-01');
      return jsonResponse({ height: 823_786, date: '2024-01-01' });
    }));

    const h = await liveResolveBirthdayHeight('2024-01-01', 'https://blocks.example');
    expect(h).toBe(823_786);
  });

  it('liveResolveBirthdayHeight falls back to the date approximation on failure', async () => {
    // Silence the warn we emit during fallback so the test output stays clean.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));

    const h = await liveResolveBirthdayHeight('2024-01-01', 'https://blocks.example');
    // Genesis at 2009-01-03; 2024-01-01 is about 15 years later. The crude
    // 600s-per-block approximation lands near 789k. We just sanity check
    // it is a positive number above 700k and below 900k.
    expect(h).toBeGreaterThan(700_000);
    expect(h).toBeLessThan(900_000);
  });
});

describe('cursor guard -- short-circuit path (sync.tsx:298 invariant)', () => {
  // sync.tsx:298 guards the or-stealth-envelope-update POST with:
  //
  //   if (!useMock && result.lastBlockScanned > (envJson.last_block_scanned ?? -1))
  //
  // The correctness of that guard depends entirely on runSync returning the
  // STORED cursor unchanged when the wallet is already current (fromHeight > tip).
  // If runSync returned tip instead, the guard would be true and future syncs
  // would silently skip blocks that were never scanned.
  //
  // These tests pin that contract at the library boundary so the route-level
  // guard can be reasoned about in isolation.

  it('returns stored cursor unchanged when already at tip (fromHeight > tip)', async () => {
    const orStealthKey = randomKeyB64();
    const payload: WalletEnvelopePayload = {
      kind: 'xpub_stealth',
      xpub: BIP84_XPUB,
      label: 'cursor-guard-at-tip',
      wallet_birthday: '2024-01-01',
      gap_limit: 5,
      script_type: 'p2wpkh',
    };
    const envelope = await sealEnvelope(payload, orStealthKey);

    const storedCursor = 850_000;
    // tip == storedCursor => fromHeight = max(birthdayHeight, storedCursor + 1)
    //                                   = 850_001 > 850_000 = tip => short-circuit.
    const fetchFilter = vi.fn();
    const fetchBlock = vi.fn();

    const result = await runSync({
      envelope,
      orStealthKey,
      birthdayHeight: 800_000,
      lastBlockScanned: storedCursor,
      fetchTip: async () => storedCursor,
      fetchFilter,
      fetchBlock,
    });

    // Cursor must be the stored value, not tip. This is what keeps
    // sync.tsx:298 from firing or-stealth-envelope-update incorrectly.
    expect(result.lastBlockScanned).toBe(storedCursor);
    expect(result.txCount).toBe(0);
    expect(result.sealedTransactions).toHaveLength(0);
    // Short-circuit must not touch the network.
    expect(fetchFilter).not.toHaveBeenCalled();
    expect(fetchBlock).not.toHaveBeenCalled();
  });

  it('returns stored cursor unchanged when tip is below stored cursor', async () => {
    // Edge: tip regressed (reorg scenario or test clock). Short-circuit still
    // fires and cursor must still come back as the stored value.
    const orStealthKey = randomKeyB64();
    const payload: WalletEnvelopePayload = {
      kind: 'xpub_stealth',
      xpub: BIP84_XPUB,
      label: 'cursor-guard-tip-below',
      wallet_birthday: '2024-01-01',
      gap_limit: 5,
      script_type: 'p2wpkh',
    };
    const envelope = await sealEnvelope(payload, orStealthKey);

    const storedCursor = 860_000;
    const fetchFilter = vi.fn();
    const fetchBlock = vi.fn();

    const result = await runSync({
      envelope,
      orStealthKey,
      birthdayHeight: 800_000,
      lastBlockScanned: storedCursor,
      fetchTip: async () => 855_000, // tip < storedCursor
      fetchFilter,
      fetchBlock,
    });

    expect(result.lastBlockScanned).toBe(storedCursor);
    expect(result.txCount).toBe(0);
    expect(fetchFilter).not.toHaveBeenCalled();
    expect(fetchBlock).not.toHaveBeenCalled();
  });

  it('advances cursor and fetches filters when behind tip (positive path)', async () => {
    // Complement of the two short-circuit tests: when the wallet is BEHIND
    // tip the guard must NOT short-circuit. Scanning runs, the filter fetch
    // is invoked, and the cursor comes back ABOVE the stored value. That is
    // the case where sync.tsx:298 must fire or-stealth-envelope-update.
    const orStealthKey = randomKeyB64();
    const payload: WalletEnvelopePayload = {
      kind: 'xpub_stealth',
      xpub: BIP84_XPUB,
      label: 'cursor-guard-advance',
      wallet_birthday: '2024-01-01',
      gap_limit: 5,
      script_type: 'p2wpkh',
    };
    const envelope = await sealEnvelope(payload, orStealthKey);

    const storedCursor = 800_000;
    const tip = 800_003 + CONFIRMATION_DEPTH;
    const fakeFilter = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const zeroHashHex = bytesToHex(new Uint8Array(32));

    // fetchFilter returns a fixture for every scanned height; the matcher
    // rejects all of them, so no block is ever fetched but every height is
    // still walked and the cursor advances to tip.
    const fetchFilter = vi.fn(async (h: number) => ({
      height: h,
      blockHashHex: zeroHashHex,
      filter: fakeFilter,
    }));
    const fetchBlock = vi.fn();

    const result = await runSync({
      envelope,
      orStealthKey,
      birthdayHeight: 800_000,
      lastBlockScanned: storedCursor,
      fetchTip: async () => tip,
      fetchFilter,
      fetchBlock,
      matcher: { matchAny: () => false },
    });

    // Guard did NOT short-circuit: filters were fetched for the scan range.
    expect(fetchFilter).toHaveBeenCalled();
    // No filter matched, so no block fetch happened...
    expect(fetchBlock).not.toHaveBeenCalled();
    // ...but the cursor still advanced above the stored value, up to the scan
    // ceiling. The ceiling is CONFIRMATION_DEPTH below the chain tip, never the
    // chain tip itself: see the confirmation-buffer describe at the end of this
    // file for why, and for the guard on that specific gap.
    expect(result.lastBlockScanned).toBeGreaterThan(storedCursor);
    expect(result.lastBlockScanned).toBe(tip - CONFIRMATION_DEPTH);
    expect(result.txCount).toBe(0);
  });

  it('stops cursor at last contiguous height when filter producer lags (404 -> null)', async () => {
    // The filter producer lags the block source: heights near tip return null
    // from fetchFilter. runSync must NOT advance the cursor past the last
    // contiguous non-null height; doing so would permanently skip those
    // heights on the next sync and miss any transactions they contain (DL-0516).
    const orStealthKey = randomKeyB64();
    const payload: WalletEnvelopePayload = {
      kind: 'xpub_stealth',
      xpub: BIP84_XPUB,
      label: 'filter-lag-cursor',
      wallet_birthday: '2024-01-01',
      gap_limit: 5,
      script_type: 'p2wpkh',
    };
    const envelope = await sealEnvelope(payload, orStealthKey);

    const storedCursor = 800_000;
    const tip = 800_005 + CONFIRMATION_DEPTH;
    // Heights 800001 and 800002 have filters; 800003-800005 are not yet
    // produced by the filter service (404 -> null). The cursor must stop at
    // 800002 so the next sync retries 800003-800005 once they are available.
    const lastAvailable = 800_002;
    const fakeFilter = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const zeroHashHex = bytesToHex(new Uint8Array(32));

    const result = await runSync({
      envelope,
      orStealthKey,
      birthdayHeight: 800_000,
      lastBlockScanned: storedCursor,
      fetchTip: async () => tip,
      fetchFilter: async (h: number) =>
        h <= lastAvailable
          ? { height: h, blockHashHex: zeroHashHex, filter: fakeFilter }
          : null,
      fetchBlock: async () => { throw new Error('no block fetch expected'); },
      matcher: { matchAny: () => false },
    });

    // Cursor must stop at lastAvailable, NOT at tip. The three heights that
    // returned null are not permanently skipped; the next sync retries them.
    expect(result.lastBlockScanned).toBe(lastAvailable);
    expect(result.lastBlockScanned).not.toBe(tip);
    expect(result.txCount).toBe(0);
  });

  describe('block-prefetch sliding window', () => {
    it('processes blocks in ascending height order when fetches resolve out of order', async () => {
      const orStealthKey = randomKeyB64();
      const payload: WalletEnvelopePayload = {
        kind: 'xpub_stealth',
        xpub: BIP84_XPUB,
        label: 'out-of-order-prefetch',
        wallet_birthday: '2024-01-01',
        gap_limit: 5,
        script_type: 'p2wpkh',
      };
      const envelope = await sealEnvelope(payload, orStealthKey);

      // Derive scripts for receive addresses 0, 1, 2.
      const scripts = [0, 1, 2].map(idx =>
        deriveScriptPubkeyBytes(BIP84_XPUB, 0, idx, 'p2wpkh'),
      );

      // Build 3 fixture blocks, one per address, at consecutive heights.
      const BASE_HEIGHT = 900_001;
      const BASE_TS = Math.floor(new Date('2024-07-01T00:00:00Z').getTime() / 1000);
      const blockBuilds = scripts.map((script, i) =>
        buildFixtureBlock({
          payToScript: script,
          amountSats: BigInt(i + 1),
          timestamp: BASE_TS + i * 600,
        }),
      );
      const blockHashes = await Promise.all(
        blockBuilds.map(async b => {
          const hash = reverseBytes(await dsha256Async(b.raw.subarray(0, 80)));
          return bytesToHex(hash);
        }),
      );

      // Manual resolvers: control fetch resolution order.
      const resolvers: Array<(b: BlockRecord) => void> = [];
      const blockPromises: Array<Promise<BlockRecord>> = blockBuilds.map((_, i) =>
        new Promise<BlockRecord>(resolve => { resolvers[i] = resolve; }),
      );

      const fakeFilter = new Uint8Array([0xaa, 0xbb]);

      const syncPromise = runSync({
        envelope,
        orStealthKey,
        birthdayHeight: BASE_HEIGHT - 1,
        lastBlockScanned: BASE_HEIGHT - 1,
        fetchTip: async () => BASE_HEIGHT + 2 + CONFIRMATION_DEPTH,
        fetchFilter: async (h: number) => {
          const idx = h - BASE_HEIGHT;
          if (idx >= 0 && idx < 3) {
            return { height: h, blockHashHex: blockHashes[idx], filter: fakeFilter };
          }
          return null;
        },
        fetchBlock: async (hashHex: string) => {
          const idx = blockHashes.indexOf(hashHex);
          return blockPromises[idx];
        },
        matcher: { matchAny: () => true },
      });

      // Wait for the filter scan to complete and runSync to start awaiting block[0].
      await new Promise(r => setTimeout(r, 10));

      // Resolve out of order: [2] first, then [0], then [1].
      // runSync awaits blockFetches[0] first, so it blocks until resolver[0]
      // fires regardless of when [1] and [2] settle.
      resolvers[2]({ height: BASE_HEIGHT + 2, blockHashHex: blockHashes[2], raw: blockBuilds[2].raw });
      await new Promise(r => setTimeout(r, 0));
      resolvers[0]({ height: BASE_HEIGHT, blockHashHex: blockHashes[0], raw: blockBuilds[0].raw });
      await new Promise(r => setTimeout(r, 0));
      resolvers[1]({ height: BASE_HEIGHT + 1, blockHashHex: blockHashes[1], raw: blockBuilds[1].raw });

      const result = await syncPromise;

      // All 3 transactions in ascending height order.
      expect(result.txCount).toBe(3);
      expect(result.normalized).toHaveLength(3);
      const heights = result.normalized.map(tx => tx.block_height);
      expect(heights).toEqual([BASE_HEIGHT, BASE_HEIGHT + 1, BASE_HEIGHT + 2]);
      expect(result.normalized[0].amount_sats).toBe(1);
      expect(result.normalized[1].amount_sats).toBe(2);
      expect(result.normalized[2].amount_sats).toBe(3);
    });

    it('produces a single rejection with no unhandled rejections when a prefetched block fails', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
      process.on('unhandledRejection', onUnhandled);

      try {
        const orStealthKey = randomKeyB64();
        const payload: WalletEnvelopePayload = {
          kind: 'xpub_stealth',
          xpub: BIP84_XPUB,
          label: 'mid-window-failure',
          wallet_birthday: '2024-01-01',
          gap_limit: 5,
          script_type: 'p2wpkh',
        };
        const envelope = await sealEnvelope(payload, orStealthKey);

        // 3 hits: all 3 prefetched at once (BLOCK_FETCH_LOOKAHEAD=8 > 3).
        const BASE_HEIGHT = 910_001;
        const fakeFilter = new Uint8Array([0xcc]);
        // 64-char hex hashes, last digit encodes index 0-2 for lookup.
        const fakeHash = (i: number) => '0'.repeat(63) + String(i);
        const errMsg = 'network-timeout';

        // Manual reject controllers: one per block.
        const rejectFns: Array<(e: Error) => void> = [];
        const blockPromises: Array<Promise<BlockRecord>> = [0, 1, 2].map(() =>
          new Promise<BlockRecord>((_, reject) => { rejectFns.push(reject); }),
        );

        const syncPromise = runSync({
          envelope,
          orStealthKey,
          birthdayHeight: BASE_HEIGHT - 1,
          lastBlockScanned: BASE_HEIGHT - 1,
          fetchTip: async () => BASE_HEIGHT + 2 + CONFIRMATION_DEPTH,
          fetchFilter: async (h: number) => {
            const idx = h - BASE_HEIGHT;
            if (idx >= 0 && idx < 3) {
              return { height: h, blockHashHex: fakeHash(idx), filter: fakeFilter };
            }
            return null;
          },
          fetchBlock: async (hashHex: string) => {
            const idx = parseInt(hashHex.at(-1) as string, 10);
            return blockPromises[idx];
          },
          matcher: { matchAny: () => true },
        });
        // Attach a rejection handler to syncPromise NOW so it is never a
        // briefly-unhandled rejected Promise during the scenario setup below.
        // rejectFns[0] causes syncPromise to reject; the 10ms gap before
        // await expect(syncPromise).rejects would leave it unhandled, firing
        // unhandledRejection and corrupting the unhandled[] collector.
        // This line only guards syncPromise -- it does not affect whether
        // blockFetches[1] and [2] fire their own unhandledRejection events,
        // which is what the test is actually verifying.
        syncPromise.catch(() => {});

        // Let the filter scan complete and all 3 prefetches be set up with
        // .catch(() => {}) already attached by _prefetchBlock.
        await new Promise(r => setTimeout(r, 10));

        // Reject block[0]: runSync is awaiting this and will throw.
        rejectFns[0](new Error(errMsg));
        await new Promise(r => setTimeout(r, 10));

        // Reject blocks[1] and [2]: without the fix these have no rejection
        // handler and would fire unhandledrejection. With the fix, the
        // .catch(()=>{}) attached at prefetch creation handles them.
        rejectFns[1](new Error(errMsg));
        rejectFns[2](new Error(errMsg));

        await expect(syncPromise).rejects.toThrow(errMsg);

        // Give the event loop time to surface any unhandled rejection events.
        await new Promise(r => setTimeout(r, 30));

        expect(unhandled).toHaveLength(0);
      } finally {
        process.removeListener('unhandledRejection', onUnhandled);
      }
    });
  });

  describe('filter fetch abort and resume (DL-1175)', () => {
    it('returns filterFetchError and advances cursor to last good height when fetchFilter throws', async () => {
      const orStealthKey = randomKeyB64();
      const payload: WalletEnvelopePayload = {
        kind: 'xpub_stealth',
        xpub: BIP84_XPUB,
        label: 'filter-fetch-abort',
        wallet_birthday: '2024-01-01',
        gap_limit: 5,
        script_type: 'p2wpkh',
      };
      const envelope = await sealEnvelope(payload, orStealthKey);

      const storedCursor = 800_000;
      const tip = 800_005 + CONFIRMATION_DEPTH;
      const failHeight = 800_003; // heights 800001 and 800002 succeed; 800003 fails
      const zeroHashHex = bytesToHex(new Uint8Array(32));
      const fakeFilter = new Uint8Array([0xde, 0xad]);
      const networkError = new Error('network-failure-DL-1175');

      const result = await runSync({
        envelope,
        orStealthKey,
        birthdayHeight: 800_000,
        lastBlockScanned: storedCursor,
        fetchTip: async () => tip,
        fetchFilter: async (h) => {
          if (h < failHeight) return { height: h, blockHashHex: zeroHashHex, filter: fakeFilter };
          throw networkError;
        },
        fetchBlock: async () => { throw new Error('no block fetch expected'); },
        matcher: { matchAny: () => false },
      });

      // runSync must NOT throw; the failure is surfaced via the return value.
      expect(result.filterFetchError).toBeDefined();
      expect(result.filterFetchError!.failedHeight).toBe(failHeight);
      expect(result.filterFetchError!.cause).toBe(networkError.message);

      // Cursor advances to the last CONTIGUOUS height successfully fetched,
      // not the stored cursor and not the tip. Heights 800001-800002 were
      // fetched; 800003+ were not. lastBlockScanned must be 800002.
      expect(result.lastBlockScanned).toBe(failHeight - 1);
      expect(result.txCount).toBe(0);
    });

    it('includes hits from heights below the failure point in the returned result', async () => {
      const orStealthKey = randomKeyB64();
      const targetScript = deriveScriptPubkeyBytes(BIP84_XPUB, 0, 0, 'p2wpkh');
      const fixtureTs = Math.floor(new Date('2024-08-01T00:00:00Z').getTime() / 1000);
      const blockBuild = buildFixtureBlock({
        payToScript: targetScript,
        amountSats: 5_000n,
        timestamp: fixtureTs,
      });
      const blockHash = reverseBytes(await dsha256Async(blockBuild.raw.subarray(0, 80)));
      const blockHashHex = bytesToHex(blockHash);

      const payload: WalletEnvelopePayload = {
        kind: 'xpub_stealth',
        xpub: BIP84_XPUB,
        label: 'filter-abort-hits',
        wallet_birthday: '2024-01-01',
        gap_limit: 5,
        script_type: 'p2wpkh',
      };
      const envelope = await sealEnvelope(payload, orStealthKey);

      const HIT_HEIGHT = 800_001;
      const FAIL_HEIGHT = 800_003;
      const fakeFilter = new Uint8Array([0xab]);

      const result = await runSync({
        envelope,
        orStealthKey,
        birthdayHeight: 800_000,
        lastBlockScanned: 800_000,
        fetchTip: async () => 800_005 + CONFIRMATION_DEPTH,
        fetchFilter: async (h) => {
          if (h >= FAIL_HEIGHT) throw new Error('transient-gone');
          return { height: h, blockHashHex: h === HIT_HEIGHT ? blockHashHex : bytesToHex(new Uint8Array(32)), filter: fakeFilter };
        },
        fetchBlock: async () => ({ height: HIT_HEIGHT, blockHashHex, raw: blockBuild.raw }),
        matcher: { matchAny: (filter, _hash, _scripts) => bytesToHex(filter) === bytesToHex(fakeFilter) },
      });

      // The tx at HIT_HEIGHT (below the failure) must be in the result.
      expect(result.txCount).toBeGreaterThan(0);
      expect(result.filterFetchError).toBeDefined();
      expect(result.filterFetchError!.failedHeight).toBe(FAIL_HEIGHT);
      // Cursor stops at FAIL_HEIGHT - 1, not at the tip.
      expect(result.lastBlockScanned).toBe(FAIL_HEIGHT - 1);
    });

    it('skip_transaction_upload path: sealedTransactions populated alongside filterFetchError', async () => {
      // Regression guard for DL-1175. The widget skips the upload step when
      // skip_transaction_upload is set and relies on OR_STEALTH_SYNC_COMPLETE
      // to deliver found transactions to the embedder. When a filter fetch
      // fails permanently, the widget posts SYNC_COMPLETE with the partial
      // result BEFORE surfacing the error. That path depends on runSync
      // returning non-empty sealedTransactions alongside filterFetchError
      // for hits below the failure height. Verify it does.
      const orStealthKey = randomKeyB64();
      const targetScript = deriveScriptPubkeyBytes(BIP84_XPUB, 0, 0, 'p2wpkh');
      const fixtureTs = Math.floor(new Date('2024-09-01T00:00:00Z').getTime() / 1000);
      const blockBuild = buildFixtureBlock({
        payToScript: targetScript,
        amountSats: 7_500n,
        timestamp: fixtureTs,
      });
      const blockHash = reverseBytes(await dsha256Async(blockBuild.raw.subarray(0, 80)));
      const blockHashHex = bytesToHex(blockHash);

      const payload: WalletEnvelopePayload = {
        kind: 'xpub_stealth',
        xpub: BIP84_XPUB,
        label: 'skip-upload-filter-fail',
        wallet_birthday: '2024-01-01',
        gap_limit: 5,
        script_type: 'p2wpkh',
      };
      const envelope = await sealEnvelope(payload, orStealthKey);

      const HIT_HEIGHT = 900_001;
      const FAIL_HEIGHT = 900_003;
      const fakeFilter = new Uint8Array([0xcd]);

      const result = await runSync({
        envelope,
        orStealthKey,
        birthdayHeight: 900_000,
        lastBlockScanned: 900_000,
        fetchTip: async () => 900_005 + CONFIRMATION_DEPTH,
        fetchFilter: async (h) => {
          if (h >= FAIL_HEIGHT) throw new Error('gone-permanent');
          return {
            height: h,
            blockHashHex: h === HIT_HEIGHT ? blockHashHex : bytesToHex(new Uint8Array(32)),
            filter: fakeFilter,
          };
        },
        fetchBlock: async () => ({ height: HIT_HEIGHT, blockHashHex, raw: blockBuild.raw }),
        matcher: { matchAny: (filter, _hash, _scripts) => bytesToHex(filter) === bytesToHex(fakeFilter) },
      });

      // Both must be present: the library must return non-empty sealedTransactions
      // alongside the error so the widget can fire SYNC_COMPLETE before throwing.
      expect(result.filterFetchError).toBeDefined();
      expect(result.sealedTransactions.length).toBeGreaterThan(0);
      expect(result.txCount).toBeGreaterThan(0);
      // Cursor must stop at the last successfully scanned height.
      expect(result.lastBlockScanned).toBe(FAIL_HEIGHT - 1);
    });
  });
});

// ─── Spend arithmetic and change tracking ───────────────────────────────
//
// Why these exist. Until the fixture builder above grew real previous
// outpoints, every transaction this file produced carried a single
// all-zero input. parseTx drops those as coinbase-like, which is correct,
// so tx.inputs was always empty and spentInputs was always 0n. The whole
// `if (spentInputs > 0n)` arm of runSync, and its twin in the extension
// loop, had therefore never run in any test while the suite reported
// green. That arm is what decides what a customer spent and what came
// back to them as change.
//
// The UTXO map is private to runSync, so these tests do not reach into
// it. They assert on what the caller can see: the normalized records, and
// whether spending an earlier change output is detected at all.

describe('runSync , spend arithmetic and change tracking', () => {
  // gap_limit 5 gives an initial window of indices [0, 10) on each chain.
  const GAP_LIMIT = 5;

  const RECEIVE_0 = deriveScriptPubkeyBytes(BIP84_XPUB, 0, 0, 'p2wpkh');
  const CHANGE_0 = deriveScriptPubkeyBytes(BIP84_XPUB, 1, 0, 'p2wpkh');
  const CHANGE_0_ADDRESS = deriveAddress(BIP84_XPUB, 1, 0, 'p2wpkh');

  // Index 50 sits far outside any window these tests derive, so the
  // orchestrator treats it as somebody else's address, while the test
  // still knows the exact string the recipient label must equal. That is
  // stronger than a bech32 shaped regex: it pins the bytes as well.
  const STRANGER = deriveScriptPubkeyBytes(BIP84_XPUB, 0, 50, 'p2wpkh');
  const STRANGER_ADDRESS = deriveAddress(BIP84_XPUB, 0, 50, 'p2wpkh');

  async function sealedEnvelopeFor(label: string, key: string) {
    const payload: WalletEnvelopePayload = {
      kind: 'xpub_stealth',
      xpub: BIP84_XPUB,
      label,
      wallet_birthday: '2024-01-01',
      gap_limit: GAP_LIMIT,
      script_type: 'p2wpkh',
    };
    return sealEnvelope(payload, key);
  }

  async function blockHashOf(raw: Uint8Array): Promise<string> {
    return bytesToHex(reverseBytes(await dsha256Async(raw.subarray(0, 80))));
  }

  it('records a spend: amount net of change, recipient labelled, change kept as ours', async () => {
    const orStealthKey = randomKeyB64();
    const envelope = await sealedEnvelopeFor('spend-arithmetic', orStealthKey);
    const ts = Math.floor(new Date('2024-06-01T00:00:00Z').getTime() / 1000);

    // Block 1 funds us with 100,000 sats on receive index 0.
    const fund = buildFixtureBlock({
      timestamp: ts,
      txs: [{ outputs: [{ script: RECEIVE_0, amountSats: 100_000n }] }],
    });
    const fundTxid = await fixtureTxid(fund.txs[0]);

    // Block 2 spends it: 60,000 to a stranger, 39,000 back to change
    // index 0, and the missing 1,000 is the network fee.
    const spend = buildFixtureBlock({
      timestamp: ts + 600,
      txs: [
        {
          inputs: [{ prevTxidHex: fundTxid, voutIdx: 0 }],
          outputs: [
            { script: STRANGER, amountSats: 60_000n },
            { script: CHANGE_0, amountSats: 39_000n },
          ],
        },
      ],
    });
    const spendTxid = await fixtureTxid(spend.txs[0]);

    // Block 3 spends the CHANGE output of block 2. This is the only
    // observable proof that the change output was recorded as ours: if it
    // had not been, this transaction pays nobody we know and spends
    // nothing we own, so it produces no record at all.
    const spendChange = buildFixtureBlock({
      timestamp: ts + 1200,
      txs: [
        {
          inputs: [{ prevTxidHex: spendTxid, voutIdx: 1 }],
          outputs: [{ script: STRANGER, amountSats: 38_500n }],
        },
      ],
    });

    const fundHash = await blockHashOf(fund.raw);
    const spendHash = await blockHashOf(spend.raw);
    const changeHash = await blockHashOf(spendChange.raw);

    const result = await runSync({
      envelope,
      orStealthKey,
      birthdayHeight: 800_000,
      lastBlockScanned: 800_000,
      fetchTip: async () => 800_003 + CONFIRMATION_DEPTH,
      fetchFilter: async (h) => {
        if (h === 800_001) return { height: h, blockHashHex: fundHash, filter: new Uint8Array([0xb1]) };
        if (h === 800_002) return { height: h, blockHashHex: spendHash, filter: new Uint8Array([0xb2]) };
        if (h === 800_003) return { height: h, blockHashHex: changeHash, filter: new Uint8Array([0xb3]) };
        return null;
      },
      fetchBlock: async (hashHex) => {
        if (hashHex === fundHash) return { height: 0, blockHashHex: fundHash, raw: fund.raw };
        if (hashHex === spendHash) return { height: 0, blockHashHex: spendHash, raw: spend.raw };
        if (hashHex === changeHash) return { height: 0, blockHashHex: changeHash, raw: spendChange.raw };
        throw new Error(`unexpected block hash ${hashHex}`);
      },
      matcher: { matchAny: () => true },
    });

    expect(result.normalized).toHaveLength(3);
    const [received, sent, sentChange] = result.normalized;

    expect(received.direction).toBe('in');
    expect(received.amount_sats).toBe(100_000);
    expect(received.txid).toBe(fundTxid);

    // The arithmetic under test: amount = spent inputs minus change back.
    // 100,000 - 39,000 = 61,000. Note what it is NOT: not the 60,000 that
    // went to the stranger, and not the 100,000 that was consumed. A sign
    // flip or an off-by-one lands on neither number.
    expect(sent.direction).toBe('out');
    expect(sent.amount_sats).toBe(61_000);
    expect(sent.address).toBe(STRANGER_ADDRESS);
    expect(sent.txid).toBe(spendTxid);
    expect(sent.block_height).toBe(800_002);
    expect(sent.vin_count).toBe(1);
    expect(sent.vout_count).toBe(2);

    // Change tracking. Block 3 spends the 39,000 change output, so it is
    // reported as an outgoing 39,000 with no change of its own. If the
    // change output had never been recorded as ours, result.normalized
    // would have two entries here, not three.
    expect(sentChange.direction).toBe('out');
    expect(sentChange.amount_sats).toBe(39_000);
    expect(sentChange.block_height).toBe(800_003);

    // The whole set round-trips through sealing, extension included.
    expect(result.sealedTransactions).toHaveLength(3);
    expect(result.txCount).toBe(3);
  });

  it('a pure self transfer nets to the fee alone and has no recipient to label', async () => {
    const orStealthKey = randomKeyB64();
    const envelope = await sealedEnvelopeFor('self-transfer', orStealthKey);
    const ts = Math.floor(new Date('2024-06-05T00:00:00Z').getTime() / 1000);

    const fund = buildFixtureBlock({
      timestamp: ts,
      txs: [{ outputs: [{ script: RECEIVE_0, amountSats: 100_000n }] }],
    });
    const fundTxid = await fixtureTxid(fund.txs[0]);

    // Everything comes back to our own change address. Nothing left the
    // wallet except the fee, so the amount must be exactly 500.
    const consolidate = buildFixtureBlock({
      timestamp: ts + 600,
      txs: [
        {
          inputs: [{ prevTxidHex: fundTxid, voutIdx: 0 }],
          outputs: [{ script: CHANGE_0, amountSats: 99_500n }],
        },
      ],
    });

    const fundHash = await blockHashOf(fund.raw);
    const consolidateHash = await blockHashOf(consolidate.raw);

    const result = await runSync({
      envelope,
      orStealthKey,
      birthdayHeight: 810_000,
      lastBlockScanned: 810_000,
      fetchTip: async () => 810_002 + CONFIRMATION_DEPTH,
      fetchFilter: async (h) => {
        if (h === 810_001) return { height: h, blockHashHex: fundHash, filter: new Uint8Array([0xc1]) };
        if (h === 810_002) return { height: h, blockHashHex: consolidateHash, filter: new Uint8Array([0xc2]) };
        return null;
      },
      fetchBlock: async (hashHex) => {
        if (hashHex === fundHash) return { height: 0, blockHashHex: fundHash, raw: fund.raw };
        if (hashHex === consolidateHash) return { height: 0, blockHashHex: consolidateHash, raw: consolidate.raw };
        throw new Error(`unexpected block hash ${hashHex}`);
      },
      matcher: { matchAny: () => true },
    });

    expect(result.normalized).toHaveLength(2);
    const sent = result.normalized[1];
    expect(sent.direction).toBe('out');
    // 100,000 spent, 99,500 back to us: the fee, and nothing else.
    expect(sent.amount_sats).toBe(500);
    // Every output pays us, so there is no recipient to name. An empty
    // string is the documented answer, not a placeholder for a failure.
    expect(sent.address).toBe('');
    expect(sent.vout_count).toBe(1);
  });

  it('labels a receive on the change chain with its chain 1 address', async () => {
    // Threading a chain 1 script through the fixture is what makes the
    // change branch of address derivation observable. If derivation ever
    // stopped walking both chains, this receive would not be seen at all.
    const orStealthKey = randomKeyB64();
    const envelope = await sealedEnvelopeFor('change-chain-receive', orStealthKey);
    const ts = Math.floor(new Date('2024-06-10T00:00:00Z').getTime() / 1000);

    const block = buildFixtureBlock({
      timestamp: ts,
      txs: [{ outputs: [{ script: CHANGE_0, amountSats: 25_000n }] }],
    });
    const blockHash = await blockHashOf(block.raw);

    const result = await runSync({
      envelope,
      orStealthKey,
      birthdayHeight: 820_000,
      lastBlockScanned: 820_000,
      fetchTip: async () => 820_001 + CONFIRMATION_DEPTH,
      fetchFilter: async (h) =>
        h === 820_001 ? { height: h, blockHashHex: blockHash, filter: new Uint8Array([0xd1]) } : null,
      fetchBlock: async () => ({ height: 0, blockHashHex: blockHash, raw: block.raw }),
      matcher: { matchAny: () => true },
    });

    expect(result.normalized).toHaveLength(1);
    expect(result.normalized[0].direction).toBe('in');
    expect(result.normalized[0].amount_sats).toBe(25_000);
    expect(result.normalized[0].address).toBe(CHANGE_0_ADDRESS);
    // Sanity: the change address is genuinely a different string from the
    // receive-chain address at the same index, so this assertion cannot
    // pass by accident on a chain 0 label.
    expect(CHANGE_0_ADDRESS).not.toBe(deriveAddress(BIP84_XPUB, 0, 0, 'p2wpkh'));
  });

  it('detects a spend that is only found in a rolling window extension pass', async () => {
    // The extension loop carries its own copy of the spend arithmetic,
    // and it was as unreached as the main one. Setup:
    //   block 1 pays receive index 5, which is inside the initial window
    //     [0, 10) and at the near-edge threshold, so extension fires.
    //   block 2 spends that outpoint and pays 39,000 to receive index 12,
    //     which no initial-window scan can match. The stub matcher models
    //     that honestly: it matches a block only when the script that
    //     block pays is among the scripts it was handed.
    // So the spending transaction is seen for the first time inside the
    // extension pass, which is the branch under test.
    const orStealthKey = randomKeyB64();
    const envelope = await sealedEnvelopeFor('spend-in-extension', orStealthKey);
    const ts = Math.floor(new Date('2024-06-20T00:00:00Z').getTime() / 1000);

    const nearEdge = deriveScriptPubkeyBytes(BIP84_XPUB, 0, 5, 'p2wpkh');
    const beyondWindow = deriveScriptPubkeyBytes(BIP84_XPUB, 0, 12, 'p2wpkh');

    const fund = buildFixtureBlock({
      timestamp: ts,
      txs: [{ outputs: [{ script: nearEdge, amountSats: 100_000n }] }],
    });
    const fundTxid = await fixtureTxid(fund.txs[0]);

    const spend = buildFixtureBlock({
      timestamp: ts + 600,
      txs: [
        {
          inputs: [{ prevTxidHex: fundTxid, voutIdx: 0 }],
          outputs: [
            { script: STRANGER, amountSats: 60_000n },
            { script: beyondWindow, amountSats: 39_000n },
          ],
        },
      ],
    });
    const spendTxid = await fixtureTxid(spend.txs[0]);

    const fundHash = await blockHashOf(fund.raw);
    const spendHash = await blockHashOf(spend.raw);

    const scriptPresent = (scripts: readonly Uint8Array[], target: Uint8Array): boolean =>
      scripts.some((s) => s.length === target.length && s.every((b, i) => b === target[i]));

    const result = await runSync({
      envelope,
      orStealthKey,
      birthdayHeight: 830_000,
      lastBlockScanned: 830_000,
      fetchTip: async () => 830_002 + CONFIRMATION_DEPTH,
      fetchFilter: async (h) => {
        if (h === 830_001) return { height: h, blockHashHex: fundHash, filter: new Uint8Array([0xe1]) };
        if (h === 830_002) return { height: h, blockHashHex: spendHash, filter: new Uint8Array([0xe2]) };
        return null;
      },
      fetchBlock: async (hashHex) => {
        if (hashHex === fundHash) return { height: 0, blockHashHex: fundHash, raw: fund.raw };
        if (hashHex === spendHash) return { height: 0, blockHashHex: spendHash, raw: spend.raw };
        throw new Error(`unexpected block hash ${hashHex}`);
      },
      // GCS semantics without WASM: a filter matches only when the script
      // its block actually pays is in the list handed to the matcher.
      matcher: {
        matchAny: (filter, _hash, scripts) => {
          if (filter[0] === 0xe1) return scriptPresent(scripts, nearEdge);
          if (filter[0] === 0xe2) return scriptPresent(scripts, beyondWindow);
          return false;
        },
      },
    });

    expect(result.normalized).toHaveLength(2);

    const received = result.normalized.find((t) => t.txid === fundTxid);
    expect(received).toBeDefined();
    expect(received!.direction).toBe('in');
    expect(received!.amount_sats).toBe(100_000);

    const sent = result.normalized.find((t) => t.txid === spendTxid);
    expect(sent).toBeDefined();
    expect(sent!.direction).toBe('out');
    // Same arithmetic as the main loop: 100,000 spent, 39,000 back to an
    // address only the extension pass knows about, so 61,000 left.
    expect(sent!.amount_sats).toBe(61_000);
    expect(sent!.address).toBe(STRANGER_ADDRESS);
    expect(sent!.block_height).toBe(830_002);

    // The match landed at the near-edge threshold, so the caller is told
    // the window was extended.
    expect(result.windowExhausted).toBe(true);
    expect(result.sealedTransactions).toHaveLength(2);
  });

  it('detects a spend that is only found in a rolling window extension pass on the change chain', async () => {
    // Same shape as the chain-0 extension test above, moved to chain 1
    // (the change branch). GAP_LIMIT is 5 here (see the outer describe),
    // so the initial window per chain is [0, 10) and the near-edge
    // threshold is index 5. Setup:
    //   block 1 pays CHANGE index 5, which is inside the initial window
    //     and at the near-edge threshold, so chain1Near fires and
    //     chainWindowEnd[1] extends.
    //   block 2 spends that outpoint and pays 39,000 to CHANGE index 12,
    //     which no initial-window scan can match on chain 1. The stub
    //     matcher models that honestly: it matches a block only when the
    //     script that block pays is among the scripts it was handed.
    // So the spending transaction is only seen once the chain-1 arm of
    // the extension loop (sync.ts:1035-1037) has actually derived index
    // 12 on chain 1 and re-scanned for it.
    const orStealthKey = randomKeyB64();
    const envelope = await sealedEnvelopeFor('spend-in-extension-chain1', orStealthKey);
    const ts = Math.floor(new Date('2024-06-25T00:00:00Z').getTime() / 1000);

    const nearEdgeChange = deriveScriptPubkeyBytes(BIP84_XPUB, 1, 5, 'p2wpkh');
    const beyondWindowChange = deriveScriptPubkeyBytes(BIP84_XPUB, 1, 12, 'p2wpkh');

    const fund = buildFixtureBlock({
      timestamp: ts,
      txs: [{ outputs: [{ script: nearEdgeChange, amountSats: 100_000n }] }],
    });
    const fundTxid = await fixtureTxid(fund.txs[0]);

    const spend = buildFixtureBlock({
      timestamp: ts + 600,
      txs: [
        {
          inputs: [{ prevTxidHex: fundTxid, voutIdx: 0 }],
          outputs: [
            { script: STRANGER, amountSats: 60_000n },
            { script: beyondWindowChange, amountSats: 39_000n },
          ],
        },
      ],
    });
    const spendTxid = await fixtureTxid(spend.txs[0]);

    const fundHash = await blockHashOf(fund.raw);
    const spendHash = await blockHashOf(spend.raw);

    const scriptPresent = (scripts: readonly Uint8Array[], target: Uint8Array): boolean =>
      scripts.some((s) => s.length === target.length && s.every((b, i) => b === target[i]));

    const result = await runSync({
      envelope,
      orStealthKey,
      birthdayHeight: 840_000,
      lastBlockScanned: 840_000,
      fetchTip: async () => 840_002,
      fetchFilter: async (h) => {
        if (h === 840_001) return { height: h, blockHashHex: fundHash, filter: new Uint8Array([0xf1]) };
        if (h === 840_002) return { height: h, blockHashHex: spendHash, filter: new Uint8Array([0xf2]) };
        return null;
      },
      fetchBlock: async (hashHex) => {
        if (hashHex === fundHash) return { height: 0, blockHashHex: fundHash, raw: fund.raw };
        if (hashHex === spendHash) return { height: 0, blockHashHex: spendHash, raw: spend.raw };
        throw new Error(`unexpected block hash ${hashHex}`);
      },
      // GCS semantics without WASM: a filter matches only when the script
      // its block actually pays is in the list handed to the matcher.
      matcher: {
        matchAny: (filter, _hash, scripts) => {
          if (filter[0] === 0xf1) return scriptPresent(scripts, nearEdgeChange);
          if (filter[0] === 0xf2) return scriptPresent(scripts, beyondWindowChange);
          return false;
        },
      },
    });

    expect(result.normalized).toHaveLength(2);

    const received = result.normalized.find((t) => t.txid === fundTxid);
    expect(received).toBeDefined();
    expect(received!.direction).toBe('in');
    expect(received!.amount_sats).toBe(100_000);

    const sent = result.normalized.find((t) => t.txid === spendTxid);
    expect(sent).toBeDefined();
    expect(sent!.direction).toBe('out');
    expect(sent!.amount_sats).toBe(61_000);
    expect(sent!.address).toBe(STRANGER_ADDRESS);
    expect(sent!.block_height).toBe(840_002);

    expect(result.windowExhausted).toBe(true);
    expect(result.sealedTransactions).toHaveLength(2);
  });
});

// ─── Reorg safety: the confirmation buffer ──────────────────────────────
//
// Bitcoin occasionally rewrites its most recent block or two. That is normal.
// A transaction recorded from a block that is then replaced stops existing,
// and runSync never revisits a height it has already covered, so the wrong
// balance is permanent rather than brief.
//
// The prevention is a scan ceiling at chainTip - CONFIRMATION_DEPTH. The trap
// inside that change, and the reason for the second test below, is that the
// coverage watermark has to move with the ceiling. A watermark that advanced
// to the raw chain tip while the scan stopped six blocks short would leave
// those six blocks unscanned by every future sync as well, because coverage
// would already claim them. A delayed balance would become a permanently
// missing one, which is worse than the defect being fixed.

describe('runSync , confirmation buffer and coverage watermark', () => {
  async function envelopeFor(label: string, key: string, gapLimit = 2) {
    const payload: WalletEnvelopePayload = {
      kind: 'xpub_stealth',
      xpub: BIP84_XPUB,
      label,
      wallet_birthday: '2024-01-01',
      gap_limit: gapLimit,
      script_type: 'p2wpkh',
    };
    return sealEnvelope(payload, key);
  }

  it('scans no higher than CONFIRMATION_DEPTH below the chain tip', async () => {
    const orStealthKey = randomKeyB64();
    const envelope = await envelopeFor('buffer-ceiling', orStealthKey);

    // Every height up to the RAW tip has a filter, so nothing except the
    // buffer can stop the walk. Without the buffer both assertions below
    // land on chainTip instead.
    const chainTip = 800_020;
    const heightsAsked: number[] = [];
    const zeroHashHex = bytesToHex(new Uint8Array(32));

    const result = await runSync({
      envelope,
      orStealthKey,
      birthdayHeight: 800_000,
      lastBlockScanned: 800_000,
      fetchTip: async () => chainTip,
      fetchFilter: async (h) => {
        heightsAsked.push(h);
        return { height: h, blockHashHex: zeroHashHex, filter: new Uint8Array([0xf0]) };
      },
      fetchBlock: async () => { throw new Error('no block fetch expected'); },
      matcher: { matchAny: () => false },
    });

    expect(Math.max(...heightsAsked)).toBe(chainTip - CONFIRMATION_DEPTH);
    expect(result.lastBlockScanned).toBe(chainTip - CONFIRMATION_DEPTH);

    // Pin the value, not just the behaviour. 6 is the Bitcoin convention and
    // it decides how long a customer waits before money appears; changing it
    // should require changing a test that says so out loud.
    expect(CONFIRMATION_DEPTH).toBe(6);
  });

  it('never advances the cursor past the highest block it actually scanned', async () => {
    // Three shapes, because the cursor is arrived at differently in each:
    // everything available, a filter producer that lags, and a permanent
    // fetch failure part way through the range.
    const shapes = [
      { name: 'all filters available', gapAt: null, throwAt: null },
      { name: 'filter producer lags', gapAt: 800_004, throwAt: null },
      { name: 'filter fetch fails permanently', gapAt: null, throwAt: 800_004 },
    ] as const;

    for (const shape of shapes) {
      const orStealthKey = randomKeyB64();
      const envelope = await envelopeFor(`watermark-${shape.name}`, orStealthKey);

      const chainTip = 800_020;
      const scanned: number[] = [];
      const zeroHashHex = bytesToHex(new Uint8Array(32));

      const result = await runSync({
        envelope,
        orStealthKey,
        birthdayHeight: 800_000,
        lastBlockScanned: 800_000,
        fetchTip: async () => chainTip,
        fetchFilter: async (h) => {
          if (shape.throwAt !== null && h >= shape.throwAt) {
            throw new Error('permanent-fetch-failure');
          }
          if (shape.gapAt !== null && h >= shape.gapAt) return null;
          scanned.push(h);
          return { height: h, blockHashHex: zeroHashHex, filter: new Uint8Array([0xf1]) };
        },
        fetchBlock: async () => { throw new Error('no block fetch expected'); },
        matcher: { matchAny: () => false },
      });

      // Stated as an invariant rather than as a number, so it keeps holding
      // when the fixtures move: the watermark may never claim a height that
      // was not actually read...
      expect(result.lastBlockScanned).toBeLessThanOrEqual(Math.max(...scanned));
      // ...and may never reach into the confirmation buffer.
      expect(result.lastBlockScanned).toBeLessThanOrEqual(chainTip - CONFIRMATION_DEPTH);
    }
  });

  it('withholds a transaction while its block is unconfirmed, then records it once buried', async () => {
    // The whole point, from the customer's side. Same block, same
    // transaction, two syncs, and the only thing that changes between them is
    // how deep the block sits.
    const orStealthKey = randomKeyB64();
    const envelope = await envelopeFor('buffer-then-record', orStealthKey);

    const targetScript = deriveScriptPubkeyBytes(BIP84_XPUB, 0, 0, 'p2wpkh');
    const ts = Math.floor(new Date('2024-06-01T12:00:00Z').getTime() / 1000);
    const blockBuild = buildFixtureBlock({
      payToScript: targetScript,
      amountSats: 5_000_000n,
      timestamp: ts,
    });
    const blockHashHex = bytesToHex(
      reverseBytes(await dsha256Async(blockBuild.raw.subarray(0, 80))),
    );
    const fakeFilter = new Uint8Array([0xf2]);
    const PAYING_HEIGHT = 900_000;

    const io = (chainTip: number) => ({
      envelope,
      orStealthKey,
      birthdayHeight: PAYING_HEIGHT,
      lastBlockScanned: PAYING_HEIGHT - 1,
      fetchTip: async () => chainTip,
      fetchFilter: async (h: number) => ({
        height: h,
        blockHashHex: h === PAYING_HEIGHT ? blockHashHex : bytesToHex(new Uint8Array(32)),
        filter: fakeFilter,
      }),
      fetchBlock: async () => ({ height: PAYING_HEIGHT, blockHashHex, raw: blockBuild.raw }),
      // Matches only the paying block, by hash. The orchestrator hands the
      // hash over in internal little-endian order, hence the reversal here.
      matcher: {
        matchAny: (_filter: Uint8Array, hash: Uint8Array) =>
          bytesToHex(hash) === bytesToHex(reverseBytes(hexToBytes(blockHashHex))),
      },
    });

    // Sync one. The paying block is 2 deep, inside the 6-block buffer.
    const early = await runSync(io(PAYING_HEIGHT + 2));
    expect(early.txCount).toBe(0);
    expect(early.normalized).toEqual([]);
    // And the cursor must NOT have moved past the paying block. If it had,
    // the money would never be found by any later sync either, which is the
    // failure this whole change is trying not to introduce.
    expect(early.lastBlockScanned).toBeLessThan(PAYING_HEIGHT);

    // Sync two. Nothing about the chain data changed; only its depth did.
    const later = await runSync(io(PAYING_HEIGHT + CONFIRMATION_DEPTH));
    expect(later.txCount).toBe(1);
    expect(later.normalized[0].amount_sats).toBe(5_000_000);
    expect(later.normalized[0].block_height).toBe(PAYING_HEIGHT);
    expect(later.lastBlockScanned).toBe(PAYING_HEIGHT);
  });
});

describe('stealth sync , the abort gap and what may be uploaded (OR-T1120)', () => {
  it('does not seal an extension-pass match found above an aborted filter fetch', async () => {
    // THE FAILURE THIS GUARDS. A filter fetch fails permanently part way
    // through a sync. The main scan trims its own hits back to the last
    // contiguous height it read. The rolling-window extension pass builds a
    // SEPARATE array and, before the fix, had no equivalent trim: its
    // cache-miss branch skips a broken height and keeps walking, so it can
    // match a block ABOVE the gap. That transaction is sealed and uploaded,
    // and the server advances the stored cursor to the height it landed at.
    // The next sync then resumes above heights nobody ever read, and any
    // payment inside them is missing from the customer's balance for good,
    // with no error and no retry path.
    //
    // LAYOUT. gap_limit=2 gives an initial window of indices 0..3 per chain,
    // so a match at index 3 sits near the edge and fires the extension loop.
    //   800_001  pays index 3, inside the scanned range, must be kept
    //   800_002  filter fetch throws permanently, this is the gap
    //   800_003  pays index 4, matchable ONLY by the extension pass, above the gap
    //   800_004  no filter
    const orStealthKey = randomKeyB64();
    const payload: WalletEnvelopePayload = {
      kind: 'xpub_stealth',
      xpub: BIP84_XPUB,
      label: 'abort-gap-extension',
      wallet_birthday: '2024-01-01',
      gap_limit: 2,
      script_type: 'p2wpkh',
    };
    const envelope = await sealEnvelope(payload, orStealthKey);

    const scriptIdx3 = deriveScriptPubkeyBytes(BIP84_XPUB, 0, 3, 'p2wpkh');
    const scriptIdx4 = deriveScriptPubkeyBytes(BIP84_XPUB, 0, 4, 'p2wpkh');

    const tsA = Math.floor(new Date('2024-09-01T10:00:00Z').getTime() / 1000);
    const tsC = Math.floor(new Date('2024-09-03T10:00:00Z').getTime() / 1000);
    const blockA = buildFixtureBlock({ payToScript: scriptIdx3, amountSats: 11_000n, timestamp: tsA });
    const blockC = buildFixtureBlock({ payToScript: scriptIdx4, amountSats: 22_000n, timestamp: tsC });

    const hashHexA = bytesToHex(reverseBytes(await dsha256Async(blockA.raw.subarray(0, 80))));
    const hashHexC = bytesToHex(reverseBytes(await dsha256Async(blockC.raw.subarray(0, 80))));

    // Filters are distinguishable by first byte so the stub matcher can answer
    // per-block without a WASM GCS implementation, same trick as the tests above.
    const filterA = new Uint8Array([0xb1]);
    const filterC = new Uint8Array([0xb3]);

    // Every height the filter fetcher is asked for, in the order it is asked.
    // Used below to prove the run really had something above the gap to trim,
    // rather than passing because the extension pass found nothing up there.
    const heightsAsked: number[] = [];

    const result = await runSync({
      envelope,
      orStealthKey,
      birthdayHeight: 800_000,
      lastBlockScanned: 800_000,
      fetchTip: async () => 800_004 + CONFIRMATION_DEPTH,
      fetchFilter: async (h) => {
        heightsAsked.push(h);
        if (h === 800_001) return { height: h, blockHashHex: hashHexA, filter: filterA };
        // A PERMANENT failure. opts.fetchFilter is the layer that retries, so a
        // throw here is exactly what the orchestrator sees once attempts are
        // exhausted, not a transient blip it would recover from.
        if (h === 800_002) throw new Error('filter 800_002 permanently unavailable');
        if (h === 800_003) return { height: h, blockHashHex: hashHexC, filter: filterC };
        return null;
      },
      fetchBlock: async (hashHex) => {
        if (hashHex === hashHexA) return { height: 0, blockHashHex: hashHexA, raw: blockA.raw };
        if (hashHex === hashHexC) return { height: 0, blockHashHex: hashHexC, raw: blockC.raw };
        throw new Error(`unexpected block hash ${hashHex}`);
      },
      //   filterA (pays idx3): matches while idx3 is in scripts, the initial scan only.
      //   filterC (pays idx4): matches only once idx4 exists, the extension pass only.
      matcher: {
        matchAny: (filter, _hash, scripts) => {
          const target = filter[0] === 0xb1 ? scriptIdx3
            : filter[0] === 0xb3 ? scriptIdx4
            : null;
          if (!target) return false;
          return scripts.some((s) => s.length === target.length && s.every((b, i) => b === target[i]));
        },
      },
    });

    // The abort is real and not merely assumed: the run names the height that failed.
    expect(result.filterFetchError?.failedHeight).toBe(800_002);

    // WHAT MAKES THIS CASE DISCRIMINATING, asserted rather than assumed.
    //
    // The assertions further down only fail on the parent commit if the run
    // actually produced an extension-pass hit at 800_003. Two things have to
    // hold for that, and neither is guaranteed by the fixture on its own:
    //
    // 1. The filter at 800_003 was read. The initial scan dispatches it
    //    concurrently with the abort at 800_002, and the extension pass re-reads
    //    it on a cache miss, so it should be asked for either way. If it were
    //    never asked there would be no filter above the gap to match, the trim
    //    would remove nothing, and every assertion below would hold on the
    //    parent commit too.
    expect(heightsAsked).toContain(800_003);
    // 2. The rolling-window extension pass ran. It derives index 4, and index 4
    //    is the only thing that can match 800_003 at all: the initial scan's
    //    window stops at index 3. windowExhausted is set on entry to that loop,
    //    so it is the honest signal that the pass happened.
    expect(result.windowExhausted).toBe(true);

    // The cursor stops below the gap. This part was already correct.
    expect(result.lastBlockScanned).toBe(800_001);

    // THE ASSERTIONS THAT FAIL WITHOUT THE TRIM. The extension match at 800_003
    // sits above the gap, so it must not be recorded, sealed or uploaded.
    expect(result.normalized.map((t) => t.block_height)).toEqual([800_001]);
    expect(result.normalized.find((t) => t.amount_sats === 22_000)).toBeUndefined();
    expect(result.sealedTransactions).toHaveLength(1);

    // The invariant, stated directly rather than pinned to this fixture's counts:
    // nothing is ever uploaded from a height above the last one actually scanned.
    for (const sealed of result.sealedTransactions) {
      expect(sealed.block_height).toBeLessThanOrEqual(result.lastBlockScanned);
    }
  });
});
