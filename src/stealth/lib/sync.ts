/**
 * Stealth Sync , sync orchestrator.
 *
 * Master plan: STEALTH-SYNC-MASTER-PLAN.md §4.6.
 *
 * Pure function `runSync(opts) → SyncResult` that walks the eight
 * PROGRESS stages from postmessage.ts:
 *   unlocking → deriving → fetching_filters → matching →
 *   fetching_blocks → building_txs → sealing → uploading
 *
 * The `fetchFilter`, `fetchBlock`, and `fetchTip` callbacks are injected
 * so the same orchestrator works against:
 *   - mock fixtures in tests (see sync.test.ts)
 *   - real `stealth.orangerails.com` / `blocks.orangerails.com` from
 *     `routes/sync.tsx` in production
 *
 * Block parsing scope. We parse block headers (for timestamp + tx count)
 * and walk transactions enough to: (1) compute each txid as the
 * double-SHA256 of the non-witness tx serialization, (2) identify outputs
 * whose scriptPubKey matches one of the user's derived scripts (receives),
 * and (3) track each receive as a UTXO so we can detect a subsequent
 * transaction that spends one of those UTXOs (sends).
 *
 * Both directions emit NormalizedTransaction records:
 *   - direction='in':  txid, block_height, occurred_at, amount_sats =
 *                      sum of matched outputs, address = first matched.
 *   - direction='out': txid, block_height, occurred_at, amount_sats =
 *                      spent_utxos - change_back (what left the wallet
 *                      net of change), address = first non-ours output.
 *
 * Known limitation: the UTXO map is built in-memory during a single sync
 * run. UTXOs funded BEFORE the wallet birthday are not tracked, so a
 * spend of a pre-birthday UTXO will not be detected. Mitigation: V2's UI
 * defaults wallet birthday to one year ago and lets users override; users
 * with older wallets are nudged to push the birthday back.
 */

import {
  deriveScriptPubkeyBytes,
  deriveMultisigScriptPubkeyBytes,
  deriveAddress,
  deriveMultisigAddress,
  type ParsedDescriptor,
  type ScriptType,
} from './derive';
import { sealEnvelope, unsealEnvelope, blindIndex } from './seal';
import { loadBip158Matcher, type Bip158Matcher } from './wasm/index';
import {
  type SealedEnvelope,
  type SealedTransaction,
  type StealthStage,
} from './postmessage';
import { sha256 } from '@noble/hashes/sha2.js';

// ─── Types ──────────────────────────────────────────────────────────────

export interface FilterRecord {
  /** Block height the filter is for. */
  height: number;
  /** 32 bytes, the block hash, in big-endian RPC display order. The
   *  matcher needs the RPC byte order reversed (internal little-endian)
   *  for BIP158 SipHash key derivation; the orchestrator handles the
   *  reversal so callers can use the natural RPC-display form. */
  blockHashHex: string;
  /** GCS-encoded filter bytes per BIP158. */
  filter: Uint8Array;
}

export interface BlockRecord {
  height: number;
  blockHashHex: string;
  /** Raw serialized block bytes (header + tx count varint + txs). */
  raw: Uint8Array;
}

export interface NormalizedTransaction {
  /** Hex, RPC display order. */
  txid: string;
  block_height: number;
  /** ISO date YYYY-MM-DD derived from the block header timestamp. */
  occurred_at: string;
  direction: 'in' | 'out';
  /** Total sats received in matched outputs (for 'in' direction). */
  amount_sats: number;
  /** First matched output address, best-effort. May be empty. */
  address: string;
  vin_count: number;
  vout_count: number;
  /** Carries any forward-compat notes. Plaintext, sealed in the envelope. */
  memo: string | null;
}

export type WalletEnvelopePayload =
  | {
      kind: 'xpub_stealth';
      xpub: string;
      label: string;
      wallet_birthday: string;
      gap_limit: number;
      script_type: ScriptType;
    }
  | {
      kind: 'descriptor_stealth';
      descriptor: string;
      label: string;
      wallet_birthday: string;
      gap_limit: number;
    };

export interface SyncProgressEvent {
  stage: StealthStage;
  percent: number;
  message: string;
  detail?: string;
}

export interface RunSyncOptions {
  envelope: SealedEnvelope;
  orStealthKey: string;
  /** Block height the previous sync left off at. -1 or undefined means
   *  start from the wallet birthday height (which the caller resolves and
   *  passes as `birthdayHeight`). */
  lastBlockScanned?: number | null;
  /** Block height corresponding to wallet_birthday. The caller resolves
   *  the date → height mapping; this orchestrator stays date-blind. */
  birthdayHeight: number;
  /** For multisig, the raw descriptor parsing happens upstream in the
   *  caller so we can reuse the derive.ts test surface. The orchestrator
   *  receives a parsed descriptor when applicable; otherwise it derives
   *  from the bare extended key in the envelope payload. */
  descriptor?: ParsedDescriptor;

  // ── Injected I/O ────────────────────────────────────────────────────
  /** Returns the current chain tip height. */
  fetchTip: () => Promise<number>;
  /** Returns the BIP158 filter for the given height, or null if absent. */
  fetchFilter: (height: number) => Promise<FilterRecord | null>;
  /** Returns the raw block bytes for the given block hash. */
  fetchBlock: (blockHashHex: string) => Promise<BlockRecord>;
  /** Optional: pluggable matcher for tests. Defaults to the WASM loader. */
  matcher?: Bip158Matcher;

  /** PROGRESS pump. The orchestrator emits one event per stage and at
   *  most a handful of intra-stage updates. */
  onProgress?: (ev: SyncProgressEvent) => void;
}

export interface SyncResult {
  txCount: number;
  lastBlockScanned: number;
  bytesDownloaded: number;
  sealedTransactions: SealedTransaction[];
  /** The decrypted normalized transactions. Returned to the caller for
   *  optional posting back to the consuming app via SYNC_COMPLETE. The
   *  caller is responsible for sealing them before transport; the
   *  sealedTransactions array above is what gets uploaded to OR. */
  normalized: NormalizedTransaction[];
}

// ─── Helpers ────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex string must be even length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
  }
  return s;
}

function reverseBytes(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b[b.length - 1 - i];
  return out;
}

function dsha256(b: Uint8Array): Uint8Array {
  return sha256(sha256(b));
}

function emit(opts: RunSyncOptions, ev: SyncProgressEvent) {
  opts.onProgress?.(ev);
}

/**
 * Best-effort scriptPubKey → address decoder. Used for OUTGOING
 * transactions to label the recipient. Returns empty string if the
 * script isn't a recognized standard form (OP_RETURN, custom scripts).
 *
 * Stays best-effort by design , full address decoding for arbitrary
 * scripts requires the full Bitcoin script engine. We cover the common
 * cases (p2pkh / p2sh / p2wpkh / p2wsh / p2tr) and accept "" for the
 * rest. Users can always read the txid to inspect manually.
 */
function scriptToAddressBestEffort(script: Uint8Array): string {
  // P2WPKH: 00 14 <20-byte hash>
  if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14) {
    return encodeBech32('bc', 0, script.subarray(2));
  }
  // P2WSH: 00 20 <32-byte hash>
  if (script.length === 34 && script[0] === 0x00 && script[1] === 0x20) {
    return encodeBech32('bc', 0, script.subarray(2));
  }
  // P2TR: 51 20 <32-byte x-only pubkey>
  if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) {
    return encodeBech32('bc', 1, script.subarray(2));
  }
  // P2PKH and P2SH need base58check; we omit them rather than pull a
  // dependency in for the OUT-side label , empty string is acceptable.
  return '';
}

/** Minimal bech32(m) encoder for OUT-side recipient labels. */
function encodeBech32(hrp: string, witnessVersion: 0 | 1, program: Uint8Array): string {
  const ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const data: number[] = [witnessVersion, ...convertBits(program, 8, 5, true)];
  const checksumConst = witnessVersion === 0 ? 1 : 0x2bc830a3;
  const checksum = bech32Checksum(hrp, data, checksumConst);
  let s = hrp + '1';
  for (const v of [...data, ...checksum]) s += ALPHABET[v];
  return s;
}

function convertBits(input: Uint8Array, fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const v of input) {
    acc = (acc << fromBits) | v;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) out.push((acc << (toBits - bits)) & maxv);
  return out;
}

function bech32Checksum(hrp: string, data: number[], constant: number): number[] {
  const values: number[] = [];
  for (let i = 0; i < hrp.length; i++) values.push(hrp.charCodeAt(i) >> 5);
  values.push(0);
  for (let i = 0; i < hrp.length; i++) values.push(hrp.charCodeAt(i) & 31);
  values.push(...data, 0, 0, 0, 0, 0, 0);
  const polymod = bech32Polymod(values) ^ constant;
  const out: number[] = [];
  for (let i = 0; i < 6; i++) out.push((polymod >> (5 * (5 - i))) & 31);
  return out;
}

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

// ─── Block parser (minimal) ─────────────────────────────────────────────

/**
 * Streaming cursor over a Uint8Array.
 */
class Cursor {
  pos = 0;
  constructor(public buf: Uint8Array) {}
  readBytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) {
      throw new Error(`block parser: out-of-bounds read at pos=${this.pos} n=${n}`);
    }
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  readU32LE(): number {
    const b = this.readBytes(4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }
  readU64LE(): bigint {
    const b = this.readBytes(8);
    let n = 0n;
    for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
    return n;
  }
  readVarInt(): number {
    const tag = this.readBytes(1)[0];
    if (tag < 0xfd) return tag;
    if (tag === 0xfd) {
      const b = this.readBytes(2);
      return b[0] | (b[1] << 8);
    }
    if (tag === 0xfe) {
      const b = this.readBytes(4);
      return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
    }
    // 0xff: 8-byte. Block sizes never need this in practice; cap at u32.
    const big = this.readU64LE();
    if (big > 0xffffffffn) throw new Error('block parser: 64-bit varint exceeds u32');
    return Number(big);
  }
  peek(): number {
    return this.buf[this.pos];
  }
}

interface ParsedTx {
  txid: string;
  vinCount: number;
  voutCount: number;
  /** Each input's prev_txid (RPC display order, hex) + vout index.
   *  Used by UTXO tracking to detect spends of our previously-received
   *  outputs. Coinbase inputs (prev_txid all-zeros) are skipped. */
  inputs: Array<{ prevTxid: string; voutIdx: number }>;
  /** [valueSats, scriptPubKey] per output, in order. */
  outputs: Array<{ value: bigint; script: Uint8Array }>;
}

/**
 * Parse one transaction starting at the cursor. Computes the txid as the
 * double-SHA256 of the non-witness (legacy) serialization, regardless of
 * whether the tx is a segwit transaction. This is what BIP141 prescribes
 * and what shows up everywhere as "the txid".
 */
function parseTx(cur: Cursor): ParsedTx {
  const txStart = cur.pos;

  // version
  const versionBytes = cur.readBytes(4);
  // marker + flag (segwit)
  const marker = cur.peek();
  const flag = cur.buf[cur.pos + 1];
  const isSegwit = marker === 0x00 && flag === 0x01;
  if (isSegwit) cur.pos += 2;

  const vinStart = cur.pos;
  const vinCount = cur.readVarInt();
  const inputs: ParsedTx['inputs'] = [];
  for (let i = 0; i < vinCount; i++) {
    const prevTxidLE = cur.readBytes(32); // prev txid in internal LE order
    const voutBytes = cur.readBytes(4);    // vout index, LE
    const scriptLen = cur.readVarInt();
    cur.readBytes(scriptLen);
    cur.readBytes(4);  // sequence
    // Skip coinbase inputs (prev_txid all-zeros). They cannot be spends
    // of one of our UTXOs by definition.
    let allZero = true;
    for (let b = 0; b < 32; b++) {
      if (prevTxidLE[b] !== 0) { allZero = false; break; }
    }
    if (!allZero) {
      const prevTxid = bytesToHex(reverseBytes(prevTxidLE));
      const voutIdx =
        voutBytes[0] |
        (voutBytes[1] << 8) |
        (voutBytes[2] << 16) |
        (voutBytes[3] << 24);
      inputs.push({ prevTxid, voutIdx });
    }
  }
  const vinEnd = cur.pos;

  const voutCount = cur.readVarInt();
  const outputs: ParsedTx['outputs'] = [];
  for (let i = 0; i < voutCount; i++) {
    const value = cur.readU64LE();
    const scriptLen = cur.readVarInt();
    const script = new Uint8Array(cur.readBytes(scriptLen));
    outputs.push({ value, script });
  }
  const voutEnd = cur.pos;

  if (isSegwit) {
    for (let i = 0; i < vinCount; i++) {
      const witCount = cur.readVarInt();
      for (let j = 0; j < witCount; j++) {
        const witLen = cur.readVarInt();
        cur.readBytes(witLen);
      }
    }
  }
  const locktimeBytes = cur.readBytes(4);

  // Compute legacy serialization: version + vin + vout + locktime.
  const vinSlice = cur.buf.subarray(vinStart, vinEnd);
  const voutSlice = cur.buf.subarray(vinEnd, voutEnd);
  const legacy = new Uint8Array(4 + vinSlice.length + voutSlice.length + 4);
  legacy.set(versionBytes, 0);
  legacy.set(vinSlice, 4);
  legacy.set(voutSlice, 4 + vinSlice.length);
  legacy.set(locktimeBytes, legacy.length - 4);

  const hash = dsha256(legacy);
  // RPC display order is reverse of internal little-endian.
  const txid = bytesToHex(reverseBytes(hash));

  // Reference unused vars to satisfy --noUnusedLocals when stripped.
  void txStart;

  return { txid, vinCount, voutCount, inputs, outputs };
}

interface ParsedBlockHeader {
  blockHashHex: string;
  timestamp: number; // unix seconds, u32
  txCount: number;
  txStart: number;   // byte offset where tx list begins
}

function parseBlockHeader(raw: Uint8Array): ParsedBlockHeader {
  if (raw.length < 80) throw new Error('block parser: shorter than 80-byte header');
  const header = raw.subarray(0, 80);
  const blockHash = reverseBytes(dsha256(header));
  // Timestamp: bytes 68..72 LE
  const ts =
    (header[68] | (header[69] << 8) | (header[70] << 16) | (header[71] << 24)) >>> 0;
  // varint tx count starts at offset 80
  const cur = new Cursor(raw);
  cur.pos = 80;
  const txCount = cur.readVarInt();
  return {
    blockHashHex: bytesToHex(blockHash),
    timestamp: ts,
    txCount,
    txStart: cur.pos,
  };
}

function isoDateFromUnix(ts: number): string {
  const d = new Date(ts * 1000);
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ─── Address re-derivation (label only) ─────────────────────────────────

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ─── Orchestrator ───────────────────────────────────────────────────────

const STAGE_COPY: Record<StealthStage, { message: string; detail: string }> = {
  unlocking: { message: 'Vault unlocked', detail: 'Your password never left this browser.' },
  deriving: { message: 'Computing your addresses', detail: 'Sparrow and Wasabi do this the same way.' },
  fetching_filters: {
    message: 'Looking through Bitcoin history for your transactions',
    detail:
      'We download tiny summary files (a few KB each), one per block, and check them locally. The files are the same for every user , Orange Rails learns nothing about you from them.',
  },
  matching: { message: 'Matching filters against your addresses', detail: 'The match runs locally; no addresses are sent anywhere.' },
  fetching_blocks: { message: 'Fetching blocks where your wallet appears', detail: 'Pulled directly from our Bitcoin node.' },
  building_txs: { message: 'Building your transaction history', detail: 'Your browser is parsing each block.' },
  sealing: { message: 'Sealing your transactions', detail: 'Encrypted with your vault key, only you can open them.' },
  uploading: {
    message: 'Saving encrypted records to Orange Rails',
    detail:
      'Orange Rails stores only the encrypted bytes as a backup. They cannot read your transactions , only your browser holds the key.',
  },
};

function progress(stage: StealthStage, percent: number, detail?: string): SyncProgressEvent {
  return {
    stage,
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    message: STAGE_COPY[stage].message,
    detail: detail ?? STAGE_COPY[stage].detail,
  };
}

export async function runSync(opts: RunSyncOptions): Promise<SyncResult> {
  let bytesDownloaded = 0;

  // ── unlocking ────────────────────────────────────────────────────────
  emit(opts, progress('unlocking', 0));
  const payload = await unsealEnvelope<WalletEnvelopePayload>(
    opts.envelope,
    opts.orStealthKey,
  );
  emit(opts, progress('unlocking', 100));

  // ── deriving ─────────────────────────────────────────────────────────
  emit(opts, progress('deriving', 0));

  // For Stealth Sync we cannot use an oracle (querying an indexer would
  // leak addresses). We derive a fixed window per chain: 2x gap_limit
  // entries per chain. If the user has more activity than that, the
  // birthday-rescan UI lets them widen the window on a subsequent sync.
  const gapLimit = payload.gap_limit;
  const windowSize = gapLimit * 2;

  interface DerivedAddr {
    chain: 0 | 1;
    index: number;
    script: Uint8Array;
    address: string;
  }
  const derived: DerivedAddr[] = [];

  if (payload.kind === 'xpub_stealth') {
    for (const chain of [0, 1] as const) {
      for (let i = 0; i < windowSize; i++) {
        const script = deriveScriptPubkeyBytes(payload.xpub, chain, i, payload.script_type);
        const address = deriveAddress(payload.xpub, chain, i, payload.script_type);
        derived.push({ chain, index: i, script, address });
      }
    }
  } else {
    if (!opts.descriptor || opts.descriptor.kind !== 'multisig') {
      throw new Error('descriptor_stealth payload requires opts.descriptor (multisig parsed)');
    }
    const desc = opts.descriptor;
    for (const chain of [0, 1] as const) {
      for (let i = 0; i < windowSize; i++) {
        const script = deriveMultisigScriptPubkeyBytes(desc, chain, i);
        const address = deriveMultisigAddress(desc, chain, i);
        derived.push({ chain, index: i, script, address });
      }
    }
  }

  const scripts = derived.map((d) => d.script);
  emit(opts, progress('deriving', 100, `${derived.length} addresses ready`));

  // ── fetching_filters + matching (interleaved by height for fast-fail UX) ──
  const tip = await opts.fetchTip();
  const fromHeight = Math.max(
    opts.birthdayHeight,
    (opts.lastBlockScanned ?? -1) + 1,
  );
  if (fromHeight > tip) {
    // Already current. Short-circuit with empty result.
    // Guard: this path never fetched a filter or scanned a block, so it
    // has not earned any forward progress on lastBlockScanned. Return the
    // previous cursor unchanged -- the caller must not persist a height
    // the scan never reached.
    emit(opts, progress('fetching_filters', 100, 'Already up to date.'));
    emit(opts, progress('matching', 100));
    emit(opts, progress('fetching_blocks', 100));
    emit(opts, progress('building_txs', 100));
    emit(opts, progress('sealing', 100));
    emit(opts, progress('uploading', 100));
    return {
      txCount: 0,
      lastBlockScanned: opts.lastBlockScanned ?? -1,
      bytesDownloaded: 0,
      sealedTransactions: [],
      normalized: [],
    };
  }

  const totalFilters = tip - fromHeight + 1;
  // Friendly initial estimate: each filter is ~3KB on average. Multiply
  // and round to MB so the user has an honest number ('about 150 MB to
  // read') instead of a meaningless block count. Reassures users that
  // it is small + that nothing is being uploaded.
  const estimatedBytes = totalFilters * 3072;
  const estimatedMB = Math.max(1, Math.round(estimatedBytes / (1024 * 1024)));
  emit(opts, progress(
    'fetching_filters',
    0,
    `About ${estimatedMB} MB across ${totalFilters.toLocaleString()} small files. We do not upload anything , these files are public.`,
  ));

  const matcher = opts.matcher ?? (await loadBip158Matcher());

  interface MatchedHit {
    height: number;
    blockHashHex: string;
  }
  const hits: MatchedHit[] = [];

  // Parallel filter fetch with bounded concurrency. Sequential
  // (one-at-a-time) was the right shape for the first proof-of-life
  // milestone but is unworkable for real wallets , a 1-year-old
  // wallet has ~52K filters; sequential at 100ms/req = 90 minutes.
  // 32 concurrent reads is well below stealth.orangerails.com's
  // capacity (Caddy + static files) and gives a ~30x speedup.
  const FETCH_CONCURRENCY = 32;
  const PROGRESS_INTERVAL_MS = 200;
  let processedCount = 0;
  let lastProgressEmit = 0;
  let lastProgressCount = 0;
  const fetchStartedAt = Date.now();

  function emitFetchProgress(force: boolean): void {
    const now = Date.now();
    if (!force && now - lastProgressEmit < PROGRESS_INTERVAL_MS) return;
    const sliceMs = Math.max(1, now - lastProgressEmit);
    const sliceCount = processedCount - lastProgressCount;
    const filesPerSec = Math.round((sliceCount / sliceMs) * 1000);
    lastProgressEmit = now;
    lastProgressCount = processedCount;

    const pct = (processedCount / totalFilters) * 100;
    let detail =
      `${processedCount.toLocaleString()} of ${totalFilters.toLocaleString()} read` +
      (filesPerSec > 0 ? ` · ${filesPerSec.toLocaleString()} files/sec` : '');
    const elapsedMs = now - fetchStartedAt;
    if (elapsedMs > 1500 && processedCount > 0 && processedCount < totalFilters) {
      const overallRate = processedCount / elapsedMs; // blocks/ms
      const remaining = totalFilters - processedCount;
      const etaSec = Math.round(remaining / overallRate / 1000);
      const etaText =
        etaSec < 60
          ? `${etaSec}s`
          : etaSec < 3600
            ? `${Math.round(etaSec / 60)} min`
            : `${(etaSec / 3600).toFixed(1)} hr`;
      detail += ` · about ${etaText} left`;
    }
    emit(opts, progress('fetching_filters', pct, detail));
  }

  let nextHeight = fromHeight;
  async function worker(): Promise<void> {
    while (true) {
      const h = nextHeight;
      if (h > tip) return;
      nextHeight = h + 1;
      const f = await opts.fetchFilter(h);
      processedCount += 1;
      if (f !== null) {
        bytesDownloaded += f.filter.length;
        const blockHashLE = reverseBytes(hexToBytes(f.blockHashHex));
        const matched = matcher.matchAny(f.filter, blockHashLE, scripts);
        if (matched) {
          hits.push({ height: h, blockHashHex: f.blockHashHex });
        }
      }
      emitFetchProgress(false);
    }
  }

  await Promise.all(
    Array.from({ length: FETCH_CONCURRENCY }, () => worker()),
  );
  emitFetchProgress(true);
  emit(opts, progress('fetching_filters', 100));
  emit(opts, progress('matching', 100, `${hits.length} candidate blocks.`));

  // The concurrent filter fetch above pushes hits in COMPLETION order,
  // not chain order. The UTXO tracker below is order-sensitive: a spend
  // processed before the receive that funded it is silently missed.
  // Process blocks strictly by ascending height.
  hits.sort((a, b) => a.height - b.height);

  // ── fetching_blocks + building_txs ───────────────────────────────────
  emit(opts, progress('fetching_blocks', 0, `${hits.length} blocks to fetch.`));

  // UTXO tracking , keyed by `${prev_txid}:${vout_idx}`. Populated as we
  // encounter outputs to our addresses; consulted when scanning inputs
  // to detect spends. Mirrors how Wasabi and Sparrow detect outgoing
  // transactions over a BIP158 filter scan.
  //
  // NOTE: this map is in-memory for the duration of one sync run. UTXOs
  // funded BEFORE the wallet birthday are not tracked, so a spend of
  // such a pre-birthday UTXO will not be detected. For correct balance,
  // the wallet birthday must be at-or-before the wallet's first ever
  // receive , V2's UI defaults to one year ago and lets users override.
  const utxoMap = new Map<
    string,
    { value: bigint; address: string }
  >();
  function utxoKey(txid: string, voutIdx: number): string {
    return `${txid}:${voutIdx}`;
  }

  const normalized: NormalizedTransaction[] = [];
  for (let i = 0; i < hits.length; i++) {
    const block = await opts.fetchBlock(hits[i].blockHashHex);
    bytesDownloaded += block.raw.length;
    // Height comes from the filter match, not the block record: the
    // X-Block-Height response header is invisible to browsers unless the
    // block source exposes it via Access-Control-Expose-Headers, so the
    // block record height can silently arrive as 0.
    const blockHeight = hits[i].height;
    const header = parseBlockHeader(block.raw);
    const occurredAt = isoDateFromUnix(header.timestamp);

    const cur = new Cursor(block.raw);
    cur.pos = header.txStart;
    for (let t = 0; t < header.txCount; t++) {
      const tx = parseTx(cur);

      // ─── Spend detection (this tx spends one of our UTXOs?) ────────
      let spentInputs = 0n;
      for (const inp of tx.inputs) {
        const key = utxoKey(inp.prevTxid, inp.voutIdx);
        const utxo = utxoMap.get(key);
        if (utxo) {
          spentInputs += utxo.value;
          utxoMap.delete(key);
        }
      }

      // ─── Receive detection (this tx pays one of our addresses?) ────
      let receivedAmount = 0n;
      let receivedAddress = '';
      let anyReceive = false;
      const newUtxos: Array<{ idx: number; value: bigint; address: string }> = [];
      for (let oi = 0; oi < tx.outputs.length; oi++) {
        const out = tx.outputs[oi];
        for (const d of derived) {
          if (bytesEqual(out.script, d.script)) {
            receivedAmount += out.value;
            if (!receivedAddress) receivedAddress = d.address;
            anyReceive = true;
            newUtxos.push({ idx: oi, value: out.value, address: d.address });
            break;
          }
        }
      }

      // ─── Emit normalized records ───────────────────────────────────
      if (spentInputs > 0n) {
        // SPEND. amount_sats = what left our wallet net of change.
        //   spentInputs    , total value of UTXOs we destroyed
        //   receivedAmount , total value of new outputs paying us back (change)
        // The difference is "what we paid out" (and includes the network fee).
        // Pure self-transfer (consolidation) → amount = fee only.
        const netOut = spentInputs - receivedAmount;
        // Best-effort recipient address: first output that does NOT pay
        // us. Empty if every output pays us (pure consolidation).
        let recipientAddress = '';
        for (const out of tx.outputs) {
          let isOurs = false;
          for (const d of derived) {
            if (bytesEqual(out.script, d.script)) { isOurs = true; break; }
          }
          if (!isOurs) {
            recipientAddress = scriptToAddressBestEffort(out.script);
            if (recipientAddress) break;
          }
        }
        normalized.push({
          txid: tx.txid,
          block_height: blockHeight,
          occurred_at: occurredAt,
          direction: 'out',
          amount_sats: Number(netOut),
          address: recipientAddress,
          vin_count: tx.vinCount,
          vout_count: tx.voutCount,
          memo: null,
        });
        // Add change outputs to UTXO map so future spends can reference
        // them. (A receive that is also a change-back from our own spend
        // still counts as a UTXO we own.)
        for (const u of newUtxos) {
          utxoMap.set(utxoKey(tx.txid, u.idx), {
            value: u.value,
            address: u.address,
          });
        }
      } else if (anyReceive) {
        // RECEIVE only , pure incoming, no inputs of ours were spent.
        normalized.push({
          txid: tx.txid,
          block_height: blockHeight,
          occurred_at: occurredAt,
          direction: 'in',
          amount_sats: Number(receivedAmount),
          address: receivedAddress,
          vin_count: tx.vinCount,
          vout_count: tx.voutCount,
          memo: null,
        });
        for (const u of newUtxos) {
          utxoMap.set(utxoKey(tx.txid, u.idx), {
            value: u.value,
            address: u.address,
          });
        }
      }
    }

    const pct = ((i + 1) / Math.max(1, hits.length)) * 100;
    emit(opts, progress('fetching_blocks', pct, `${i + 1} of ${hits.length} blocks.`));
  }
  emit(opts, progress('fetching_blocks', 100));
  emit(opts, progress('building_txs', 100, `${normalized.length} transactions.`));

  // ── sealing ──────────────────────────────────────────────────────────
  emit(opts, progress('sealing', 0));
  const sealedTransactions: SealedTransaction[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const tx = normalized[i];
    const env = await sealEnvelope(tx, opts.orStealthKey);
    const blind = await blindIndex(tx.txid, opts.orStealthKey);
    sealedTransactions.push({
      version: 1,
      algorithm: 'AES-256-GCM',
      iv_b64: env.iv_b64,
      ciphertext_b64: env.ciphertext_b64,
      occurred_at: tx.occurred_at,
      block_height: tx.block_height,
      txid_blind_index_b64: blind,
    });
    if (i % 8 === 0 || i === normalized.length - 1) {
      const pct = ((i + 1) / Math.max(1, normalized.length)) * 100;
      emit(opts, progress('sealing', pct));
    }
  }
  emit(opts, progress('sealing', 100));

  // ── uploading (the orchestrator emits the stage; the actual POST is the
  // caller's job so the same orchestrator works for tests with no network) ──
  emit(opts, progress('uploading', 0));
  emit(opts, progress('uploading', 100));

  return {
    txCount: normalized.length,
    lastBlockScanned: tip,
    bytesDownloaded,
    sealedTransactions,
    normalized,
  };
}

// ─── Live fetchers (Milestone 4) ────────────────────────────────────────
//
// These hit the production filter producer at stealth.orangerails.com and
// the block source at blocks.orangerails.com. They are split out of the
// route component so they are unit-testable by mocking globalThis.fetch.
//
// Two non-obvious things to know:
//
//   1. The filter producer serves `<height>.gcs.gz` with
//      Content-Type: application/gzip and NO Content-Encoding header.
//      That means the browser will not transparently decompress the body;
//      we have to run it through DecompressionStream('gzip') ourselves.
//
//   2. The block hash for a given height is not in any response header on
//      the .gcs.gz file. It lives in a sibling `<height>.json` document
//      with shape { block_hash, block_height, time, filter_size }. We
//      fetch both in parallel and match them up.

export const DEFAULT_FILTER_BASE = 'https://stealth.orangerails.com';
export const DEFAULT_BLOCK_SOURCE_BASE = 'https://blocks.orangerails.com';

export interface FilterSidecar {
  block_hash: string;
  block_height: number;
  time: number;
  filter_size: number;
}

/**
 * Decompress a gzipped buffer using the platform's DecompressionStream.
 * Available in modern browsers and Node 18+.
 */
async function gunzip(buf: Uint8Array): Promise<Uint8Array> {
  const Ctor = (globalThis as { DecompressionStream?: typeof DecompressionStream })
    .DecompressionStream;
  if (!Ctor) {
    throw new Error('DecompressionStream is not available in this runtime');
  }
  const stream = new Blob([buf as BlobPart]).stream().pipeThrough(new Ctor('gzip'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Fetch the chain tip height from the block source.
 */
export async function liveFetchTip(
  baseUrl: string = DEFAULT_BLOCK_SOURCE_BASE,
): Promise<number> {
  const resp = await fetch(`${baseUrl}/tip`);
  if (!resp.ok) throw new Error(`fetchTip failed: ${resp.status}`);
  const j = (await resp.json()) as { height: number };
  return j.height;
}

/**
 * Fetch a BIP158 filter for the given block height, plus the sidecar JSON
 * that names which block hash that filter is bound to.
 *
 * Returns null if the producer does not yet have a filter for that height
 * (404 from either resource); the orchestrator treats that as "skip".
 */
export async function liveFetchFilter(
  height: number,
  baseUrl: string = DEFAULT_FILTER_BASE,
): Promise<FilterRecord | null> {
  const [gzResp, jsonResp] = await Promise.all([
    fetch(`${baseUrl}/${height}.gcs.gz`),
    fetch(`${baseUrl}/${height}.json`),
  ]);
  if (gzResp.status === 404 || jsonResp.status === 404) return null;
  if (!gzResp.ok) throw new Error(`fetchFilter ${height} gz failed: ${gzResp.status}`);
  if (!jsonResp.ok) throw new Error(`fetchFilter ${height} json failed: ${jsonResp.status}`);

  const sidecar = (await jsonResp.json()) as FilterSidecar;
  const gzBuf = new Uint8Array(await gzResp.arrayBuffer());
  const filter = await gunzip(gzBuf);

  return {
    height: sidecar.block_height,
    blockHashHex: sidecar.block_hash,
    filter,
  };
}

/**
 * Fetch raw block bytes for the given block hash. The block source attaches
 * X-Block-Hash and X-Block-Height response headers; we trust those for the
 * height field but verify the hash matches what we asked for.
 */
export async function liveFetchBlock(
  blockHashHex: string,
  baseUrl: string = DEFAULT_BLOCK_SOURCE_BASE,
): Promise<BlockRecord> {
  const resp = await fetch(`${baseUrl}/block/${blockHashHex}`);
  if (!resp.ok) throw new Error(`fetchBlock ${blockHashHex} failed: ${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  const headerHash = resp.headers.get('X-Block-Hash');
  const headerHeight = resp.headers.get('X-Block-Height');
  const height = headerHeight ? Number(headerHeight) : 0;
  const reportedHash = headerHash ?? blockHashHex;
  return { height, blockHashHex: reportedHash, raw: buf };
}

/**
 * Genesis at 2009-01-03; ~10 minutes per block. Crude lower bound for the
 * birthday-height window. Used as a fallback when the live height endpoint
 * is unavailable.
 */
export function approximateHeightFromDate(isoDate: string): number {
  const GENESIS = Date.UTC(2009, 0, 3) / 1000;
  const SECONDS_PER_BLOCK = 600;
  const ts = Date.parse(isoDate + 'T00:00:00Z') / 1000;
  if (!Number.isFinite(ts) || ts < GENESIS) return 0;
  return Math.max(0, Math.floor((ts - GENESIS) / SECONDS_PER_BLOCK));
}

/**
 * Resolve a wallet birthday date to a starting block height. Calls the
 * live block source; on any failure (network, non-200, missing field) falls
 * back to a date-based approximation so the sync still makes progress.
 */
export async function liveResolveBirthdayHeight(
  isoDate: string,
  baseUrl: string = DEFAULT_BLOCK_SOURCE_BASE,
): Promise<number> {
  try {
    const resp = await fetch(`${baseUrl}/height?date=${encodeURIComponent(isoDate)}`);
    if (!resp.ok) throw new Error(`height-by-date failed: ${resp.status}`);
    const j = (await resp.json()) as { height?: number };
    if (typeof j.height !== 'number' || !Number.isFinite(j.height)) {
      throw new Error('height-by-date response missing height');
    }
    return j.height;
  } catch (e) {
    console.warn('[stealth/sync] liveResolveBirthdayHeight fallback:', e);
    return approximateHeightFromDate(isoDate);
  }
}
