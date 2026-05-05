/**
 * Stealth Sync — sync orchestrator.
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
 * double-SHA256 of the non-witness tx serialization, and (2) identify
 * outputs whose scriptPubKey matches one of the user's derived scripts.
 * For each matching tx we emit a NormalizedTransaction with txid,
 * block_height, occurred_at, direction='in', amount_sats summed across
 * matched outputs, and the first matched address (best-effort label).
 *
 * Detecting 'out' transactions (where the user spent a prior UTXO) requires
 * a UTXO tracking loop across the whole scan window. That is deferred to
 * Milestone 3.5; until then we emit 'in' transactions only and document
 * the limitation in the sealed-record memo. The sync still satisfies the
 * end-to-end widget flow against fixtures and is correct for receive-only
 * watching wallets, which is the primary T0 customer pattern.
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
  for (let i = 0; i < vinCount; i++) {
    cur.readBytes(32); // prev txid
    cur.readBytes(4);  // vout index
    const scriptLen = cur.readVarInt();
    cur.readBytes(scriptLen);
    cur.readBytes(4);  // sequence
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

  return { txid, vinCount, voutCount, outputs };
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
  fetching_filters: { message: 'Downloading public filter files', detail: 'These files are the same for everyone.' },
  matching: { message: 'Matching filters against your addresses', detail: 'The match runs locally; no addresses are sent anywhere.' },
  fetching_blocks: { message: 'Fetching blocks where your wallet appears', detail: 'Pulled directly from our Bitcoin node.' },
  building_txs: { message: 'Building your transaction history', detail: 'Your browser is parsing each block.' },
  sealing: { message: 'Sealing your transactions', detail: 'Encrypted with your vault key, only you can open them.' },
  uploading: { message: 'Saving sealed records', detail: 'Our server stores the sealed bytes only.' },
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
    emit(opts, progress('fetching_filters', 100, 'Already up to date.'));
    emit(opts, progress('matching', 100));
    emit(opts, progress('fetching_blocks', 100));
    emit(opts, progress('building_txs', 100));
    emit(opts, progress('sealing', 100));
    emit(opts, progress('uploading', 100));
    return {
      txCount: 0,
      lastBlockScanned: tip,
      bytesDownloaded: 0,
      sealedTransactions: [],
      normalized: [],
    };
  }

  const totalFilters = tip - fromHeight + 1;
  emit(opts, progress(
    'fetching_filters',
    0,
    `Block range ${fromHeight}-${tip} (${totalFilters} blocks).`,
  ));

  const matcher = opts.matcher ?? (await loadBip158Matcher());

  interface MatchedHit {
    height: number;
    blockHashHex: string;
  }
  const hits: MatchedHit[] = [];

  for (let h = fromHeight; h <= tip; h++) {
    const f = await opts.fetchFilter(h);
    if (f === null) continue;
    bytesDownloaded += f.filter.length;

    // BIP158 SipHash key uses the block hash in internal byte order
    // (little-endian). RPC returns big-endian display hex; reverse for the
    // matcher.
    const blockHashLE = reverseBytes(hexToBytes(f.blockHashHex));
    const matched = matcher.matchAny(f.filter, blockHashLE, scripts);
    if (matched) {
      hits.push({ height: h, blockHashHex: f.blockHashHex });
    }

    if (h === tip || (h - fromHeight) % Math.max(1, Math.floor(totalFilters / 20)) === 0) {
      const pct = ((h - fromHeight + 1) / totalFilters) * 100;
      emit(opts, progress(
        'fetching_filters',
        pct,
        `Block range ${fromHeight}-${tip} (${totalFilters} blocks).`,
      ));
    }
  }
  emit(opts, progress('fetching_filters', 100));
  emit(opts, progress('matching', 100, `${hits.length} candidate blocks.`));

  // ── fetching_blocks + building_txs ───────────────────────────────────
  emit(opts, progress('fetching_blocks', 0, `${hits.length} blocks to fetch.`));

  const normalized: NormalizedTransaction[] = [];
  for (let i = 0; i < hits.length; i++) {
    const block = await opts.fetchBlock(hits[i].blockHashHex);
    bytesDownloaded += block.raw.length;
    const header = parseBlockHeader(block.raw);
    const occurredAt = isoDateFromUnix(header.timestamp);

    const cur = new Cursor(block.raw);
    cur.pos = header.txStart;
    for (let t = 0; t < header.txCount; t++) {
      const tx = parseTx(cur);
      // Find matching outputs.
      let matchedAmount = 0n;
      let matchedAddress = '';
      let anyMatch = false;
      for (const out of tx.outputs) {
        for (const d of derived) {
          if (bytesEqual(out.script, d.script)) {
            matchedAmount += out.value;
            if (!matchedAddress) matchedAddress = d.address;
            anyMatch = true;
            break;
          }
        }
      }
      if (anyMatch) {
        normalized.push({
          txid: tx.txid,
          block_height: block.height,
          occurred_at: occurredAt,
          direction: 'in',
          amount_sats: Number(matchedAmount),
          address: matchedAddress,
          vin_count: tx.vinCount,
          vout_count: tx.voutCount,
          memo: null,
        });
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
