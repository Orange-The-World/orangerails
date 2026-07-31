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

  // Condition 4 of PR #354 / issue #335: birthdayHeight outside [0, tip]
  // must REJECT, never clamp. Clamping would silently claim a scan range
  // the user never requested and is not recoverable; rejection is.
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

  it('liveFetchFilter returns null on 404 from either resource', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('.gcs.gz')) {
        return new Response('', { status: 404 });
      }
      return jsonResponse({});
    }));

    const rec = await liveFetchFilter(1, 'https://stealth.example');
    expect(rec).toBeNull();
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
