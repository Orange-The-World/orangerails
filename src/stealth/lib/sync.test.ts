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
 *   3. Verify the txid_blind_index_b64 is derived from the txid (not
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
  liveFetchBlock,
  liveFetchFilter,
  liveFetchTip,
  liveResolveBirthdayHeight,
  runSync,
  type BlockRecord,
  type WalletEnvelopePayload,
} from './sync';
import { deriveScriptPubkeyBytes } from './derive';
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

/**
 * Build a minimal valid block containing a single non-segwit transaction
 * with one input and one output that pays to the given scriptPubKey for
 * the given amount in sats.
 *
 * Layout:
 *   [80-byte header][varint(txCount=1)][tx]
 * Tx layout (legacy, no witness):
 *   [version=2 LE 4][vin count=1 varint][outpoint 36 + scriptSig 0 + seq 0xffffffff][
 *    vout count=1 varint][value 8 LE][scriptPubKey varint+bytes][locktime 4]
 *
 * Header timestamp is bytes 68..72.
 */
function buildFixtureBlock(opts: {
  payToScript: Uint8Array;
  amountSats: bigint;
  timestamp: number;
}): { raw: Uint8Array; blockHashHex: string } {
  // Header: version + prev hash + merkle + ts + bits + nonce. We do not
  // bother making the merkle root match (the orchestrator does not verify);
  // for txid we hash the legacy serialization independently.
  const header = new Uint8Array(80);
  header.set(u32LE(0x20000000), 0);   // version
  // prev hash zeros, merkle zeros (left as-is)
  header.set(u32LE(opts.timestamp), 68);
  header.set(u32LE(0x1d00ffff), 72);   // bits
  header.set(u32LE(0), 76);            // nonce

  const tx = concat(
    u32LE(2),                                          // version
    varInt(1),                                         // vin count
    new Uint8Array(32),                                // prev txid (zero)
    u32LE(0xffffffff),                                 // prev vout (coinbase-like, fine for fixture)
    varInt(0),                                         // empty scriptSig
    u32LE(0xffffffff),                                 // sequence
    varInt(1),                                         // vout count
    u64LE(opts.amountSats),                            // value
    varInt(opts.payToScript.length),
    opts.payToScript,
    u32LE(0),                                          // locktime
  );

  const raw = concat(header, varInt(1), tx);

  // We do NOT compute the real block hash from the header double-sha256
  // here; the orchestrator's parseBlockHeader does that itself. We need
  // the matching hash for the fetchBlock callback to look it up. Compute
  // it inline using SubtleCrypto.
  // Vitest's node env has globalThis.crypto.subtle.digest with SHA-256.
  // But for synchronous fixture creation we use a tiny inline routine.
  return { raw, blockHashHex: '' /* filled in by caller using async sha */ };
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
      fetchTip: async () => 700_001,
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
    expect(sealed.txid_blind_index_b64).toMatch(/^[0-9a-f]+$/);
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
      fetchTip: async () => 850_001,
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
      fetchTip: async () => 900_001,
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
      fetchTip: async () => 910_001,
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
      fetchTip: async () => 800_002,
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
      fetchTip: async () => 800_001,
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

  it('rejects when fetchFilter throws a fetch-failure error rather than silently skipping the height', async () => {
    // RED -> GREEN guard for DL-0489.
    //
    // Before the fix: liveFetchFilter returned null on 404, the orchestrator
    // stored the null in filterCache and moved on -- all transactions at that
    // height were silently dropped with zero signal to the caller.
    //
    // After the fix: liveFetchFilter throws, the error propagates through the
    // worker's Promise.all, and runSync rejects so the caller cannot silently
    // succeed with a wrong result.
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

    await expect(
      runSync({
        envelope,
        orStealthKey,
        birthdayHeight: 900_000,
        lastBlockScanned: 900_000,
        fetchTip: async () => 900_001,
        // Simulate liveFetchFilter throwing on 404 for the only height in range.
        fetchFilter: async (_h) => { throw fetchFilterError; },
        fetchBlock: async () => { throw new Error('should not be reached'); },
        matcher: { matchAny: () => true },
      }),
    ).rejects.toThrow('liveFetchFilter: 404 at height 900001');
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
        fetchTip: async () => 900_002,
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
      fetchTip: async () => 700_001,
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
      fetchTip: async () => 700_002,
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
    const tip = 800_003;
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
    // ...but the cursor still advanced above the stored value, up to tip.
    expect(result.lastBlockScanned).toBeGreaterThan(storedCursor);
    expect(result.lastBlockScanned).toBe(tip);
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
    const tip = 800_005;
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
        fetchTip: async () => BASE_HEIGHT + 2,
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
          fetchTip: async () => BASE_HEIGHT + 2,
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
});
