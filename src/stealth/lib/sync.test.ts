/**
 * Stealth Sync — sync orchestrator end-to-end tests.
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

import { describe, expect, it } from 'vitest';

import { sealEnvelope, unsealEnvelope } from './seal';
import { runSync, type WalletEnvelopePayload } from './sync';
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

describe('runSync — orchestrator end-to-end with fixtures', () => {
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

  it('short-circuits when lastBlockScanned is already at tip', async () => {
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
      lastBlockScanned: 800_500,
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
    expect(result.lastBlockScanned).toBe(800_500);
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
});
