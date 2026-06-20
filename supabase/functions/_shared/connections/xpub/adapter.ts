/**
 * xpub source adapter — watch-only on-chain Bitcoin wallet via extended public key.
 *
 * Listed as PLANNED in OrangeRails-Protocol.html §18 ("Mempool xpub"). The
 * appeal is no API key, no upstream account, no OAuth flow — paste the xpub
 * and OR scans on-chain. Works for any wallet that exposes its xpub
 * (Sparrow, Specter, Electrum, hardware wallets, BlueWallet, etc.).
 *
 * Supported prefixes (mainnet only in v1):
 *   - xpub (BIP44, P2PKH legacy)
 *   - ypub (BIP49, P2SH-P2WPKH wrapped segwit)
 *   - zpub (BIP84, P2WPKH native segwit)
 *
 * Not yet supported (v1 limitations — easy to add when a user needs them):
 *   - BIP86 P2TR (`xpub` with derivation hint, or descriptors)
 *   - Multisig (Ypub/Zpub uppercase = multisig variants)
 *   - Testnet (tpub/upub/vpub) — same code path, just version-bytes table
 *
 * Address scanning follows BIP44 gap-limit semantics: derive addresses
 * sequentially on the receive (m/0/i) and change (m/1/i) chains; stop after
 * `gap_limit` consecutive empty addresses on each chain. Capped at
 * MAX_ADDRESSES per chain to bound runaway scans of weirdly-shaped wallets.
 *
 * Indexer: mempool.space's open Esplora-compatible REST API
 * (https://mempool.space/docs/api/rest). No auth, generous unauthenticated
 * rate limits. We hit per-address `/api/address/{addr}/txs` which returns
 * the most recent ~50 confirmed txs + all current mempool txs. v1 makes no
 * effort to paginate older history — if a user has >50 confirmed txs at a
 * single address (very rare for personal wallets) we miss the older ones
 * until v1.1 adds /chain/{txid} pagination.
 *
 * Cursor: unused in v1 — every sync re-scans all addresses. The consumer's
 * (connection_id, external_id) UNIQUE constraint dedups; OR's caller-side
 * idempotence makes this safe but wasteful. v1.1 will switch to
 * cursor = max block_height seen so we can short-circuit once a tx batch
 * is fully below the cursor.
 */

import { HDKey } from 'https://esm.sh/@scure/bip32@1.4.0';
import * as btc from 'https://esm.sh/@scure/btc-signer@1.3.2';
import { base58check } from 'https://esm.sh/@scure/base@1.1.7';
import { sha256 } from 'https://esm.sh/@noble/hashes@1.4.0/sha256';

import type {
  ProviderAdapter,
  DiscoveredWallet,
  NormalizedTransaction,
  SyncResult,
} from '../types.ts';

// ─── Constants ───────────────────────────────────────────────────────────

const MEMPOOL_API = 'https://mempool.space/api';
const DEFAULT_GAP_LIMIT = 20;          // BIP44 standard
const MAX_ADDRESSES_PER_CHAIN = 500;   // safety cap — protects us from a
                                        // misconfigured wallet with weird gaps
const SOURCE_WALLET_ID = 'xpub';       // single logical wallet per connection

type ScriptType = 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh';

// Version-byte → script-type table. The xpub format encodes the script type
// in its 4-byte version prefix. We rewrite to xpub before handing to
// HDKey.fromExtendedKey (which only knows xpub/xprv) and remember the
// original script type for address derivation.
//
// Version bytes from SLIP-132 (https://github.com/satoshilabs/slips/blob/master/slip-0132.md).
const VERSION_TABLE: Record<string, { version: Uint8Array; scriptType: ScriptType }> = {
  xpub: { version: new Uint8Array([0x04, 0x88, 0xb2, 0x1e]), scriptType: 'p2pkh' },
  ypub: { version: new Uint8Array([0x04, 0x9d, 0x7c, 0xb2]), scriptType: 'p2sh-p2wpkh' },
  zpub: { version: new Uint8Array([0x04, 0xb2, 0x47, 0x46]), scriptType: 'p2wpkh' },
};

const b58check = base58check(sha256);

// ─── Credential parsing ─────────────────────────────────────────────────

interface XpubCredentials {
  /** Extended public key (xpub/ypub/zpub). */
  xpub: string;
  /** Optional override for BIP44 gap limit. Defaults to 20. */
  gap_limit?: number;
}

function parseXpubCredentials(credentials: Record<string, unknown>): XpubCredentials {
  const xpub = credentials.xpub;
  if (typeof xpub !== 'string' || xpub.length < 100) {
    throw new Error('[xpub] credentials.xpub required (extended public key)');
  }
  const gap_limit = typeof credentials.gap_limit === 'number'
    ? Math.min(Math.max(1, credentials.gap_limit), 100)
    : DEFAULT_GAP_LIMIT;
  return { xpub, gap_limit };
}

// ─── Key + address derivation ───────────────────────────────────────────

/**
 * Detect the prefix and return both the canonical xpub form (with BIP44
 * version bytes, parseable by HDKey.fromExtendedKey) and the original
 * script type so we know which payment encoding to use for addresses.
 */
function normalizeExtendedPubkey(input: string): { canonicalXpub: string; scriptType: ScriptType } {
  const prefix = input.slice(0, 4);
  const cfg = VERSION_TABLE[prefix];
  if (!cfg) {
    throw new Error(
      `[xpub] unsupported extended-pubkey prefix '${prefix}' — supported: xpub, ypub, zpub`,
    );
  }

  // Decode base58check, swap version bytes to xpub (BIP44), re-encode.
  let decoded: Uint8Array;
  try {
    decoded = b58check.decode(input);
  } catch (err) {
    throw new Error(`[xpub] base58check decode failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (decoded.length !== 78) {
    throw new Error(`[xpub] decoded extended key has wrong length ${decoded.length} (expected 78)`);
  }
  const rewritten = new Uint8Array(decoded);
  rewritten.set(VERSION_TABLE.xpub.version, 0);
  return { canonicalXpub: b58check.encode(rewritten), scriptType: cfg.scriptType };
}

function deriveAddress(hdRoot: HDKey, chain: 0 | 1, index: number, scriptType: ScriptType): string {
  const child = hdRoot.deriveChild(chain).deriveChild(index);
  if (!child.publicKey) {
    throw new Error('[xpub] derived child has no publicKey (non-finite curve point?)');
  }
  const pubkey = child.publicKey;
  let payment: { address?: string };
  switch (scriptType) {
    case 'p2pkh':
      payment = btc.p2pkh(pubkey);
      break;
    case 'p2wpkh':
      payment = btc.p2wpkh(pubkey);
      break;
    case 'p2sh-p2wpkh':
      payment = btc.p2sh(btc.p2wpkh(pubkey));
      break;
  }
  if (!payment.address) {
    throw new Error(`[xpub] payment script for ${scriptType} returned no address`);
  }
  return payment.address;
}

// ─── Mempool.space client ───────────────────────────────────────────────

interface MempoolVin {
  prevout?: {
    scriptpubkey_address?: string;
    value: number;
  };
}

interface MempoolVout {
  scriptpubkey_address?: string;
  value: number;
}

interface MempoolTx {
  txid: string;
  vin: MempoolVin[];
  vout: MempoolVout[];
  fee: number;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_time?: number;
  };
}

async function fetchAddressTxs(address: string): Promise<MempoolTx[]> {
  const res = await fetch(`${MEMPOOL_API}/address/${address}/txs`);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // 404 means "address has never been seen" — treat as empty rather than error.
    if (res.status === 404) return [];
    throw new Error(`mempool.space ${res.status} for ${address}: ${detail.slice(0, 120)}`);
  }
  const json = await res.json();
  if (!Array.isArray(json)) {
    throw new Error(`mempool.space returned non-array for ${address}`);
  }
  return json as MempoolTx[];
}

/**
 * BIP44-style gap-limit address scanner. Walks one chain (receive=0 or
 * change=1) batch-by-batch, fetching `gap_limit` addresses in parallel per
 * iteration. Stops when the most recent `gap_limit` consecutive addresses
 * are all empty.
 *
 * Returns the union of all addresses scanned (with their txs) so the caller
 * can build a unified address set for net-amount computation across the
 * combined receive + change chains.
 */
async function scanChain(
  hdRoot: HDKey,
  chain: 0 | 1,
  gapLimit: number,
  scriptType: ScriptType,
): Promise<Map<string, MempoolTx[]>> {
  const out = new Map<string, MempoolTx[]>();
  let lastUsedIdx = -1;
  let i = 0;

  while (i - lastUsedIdx <= gapLimit && i < MAX_ADDRESSES_PER_CHAIN) {
    // Batch: derive `gapLimit` addresses, fetch all in parallel.
    const batchSize = Math.min(gapLimit, MAX_ADDRESSES_PER_CHAIN - i);
    const addrs: string[] = [];
    for (let k = 0; k < batchSize; k++) {
      addrs.push(deriveAddress(hdRoot, chain, i + k, scriptType));
    }
    const results = await Promise.all(addrs.map(a => fetchAddressTxs(a)));

    for (let k = 0; k < batchSize; k++) {
      const addr = addrs[k];
      const txs = results[k];
      out.set(addr, txs);
      if (txs.length > 0) lastUsedIdx = i + k;
    }
    i += batchSize;
  }

  return out;
}

// ─── Tx normalization ───────────────────────────────────────────────────

/**
 * Compute our share of a tx's inputs and outputs, then emit a single
 * NormalizedTransaction with the net per-tx direction + amount.
 *
 * Rules:
 *   - Pure incoming (we appear only in vouts): direction='in', amount = our_out
 *     counterparty = first non-our vin address (the sender, if known)
 *   - Pure outgoing (we appear only in vins): direction='out',
 *     amount = sum(non-our vouts) = what we paid out (excluding change-back-to-self)
 *     counterparty = first non-our vout address (the recipient)
 *   - Mixed (we're in both vins and vouts): consolidation/self-transfer with change.
 *     direction = 'out', amount = our_in - our_out (= what left our wallet net of change,
 *     which equals fee for pure consolidations, or fee + amount-sent for spend-with-change).
 *     counterparty = first non-our vout address, or null if none (pure consolidation).
 *
 * type='onchain' always (this adapter only emits on-chain BTC).
 */
function normalizeXpubTx(tx: MempoolTx, ourAddrs: Set<string>): NormalizedTransaction | null {
  let ourIn = 0;
  let ourOut = 0;
  let firstExternalVinAddr: string | null = null;
  let firstExternalVoutAddr: string | null = null;

  for (const vin of tx.vin) {
    const addr = vin.prevout?.scriptpubkey_address;
    const value = vin.prevout?.value ?? 0;
    if (addr && ourAddrs.has(addr)) {
      ourIn += value;
    } else if (addr && !firstExternalVinAddr) {
      firstExternalVinAddr = addr;
    }
  }
  for (const vout of tx.vout) {
    const addr = vout.scriptpubkey_address;
    if (addr && ourAddrs.has(addr)) {
      ourOut += vout.value;
    } else if (addr && !firstExternalVoutAddr) {
      firstExternalVoutAddr = addr;
    }
  }

  // Defense: tx involves none of our addresses (shouldn't happen given how we
  // collected the tx, but guard anyway).
  if (ourIn === 0 && ourOut === 0) return null;

  let direction: 'in' | 'out';
  let amount_sats: number;
  let counterparty: string | null;

  if (ourIn === 0) {
    // Pure receive
    direction = 'in';
    amount_sats = ourOut;
    counterparty = firstExternalVinAddr;
  } else {
    // Spend (with or without change). amount = what left our wallet net of change.
    direction = 'out';
    amount_sats = ourIn - ourOut;
    counterparty = firstExternalVoutAddr; // null for pure consolidations (= fee-only spend)
  }

  // Timestamp: confirmed → block_time; mempool → now (best-effort).
  const ts = tx.status.confirmed && tx.status.block_time
    ? new Date(tx.status.block_time * 1000).toISOString()
    : new Date().toISOString();

  return {
    id: tx.txid,
    adapter: 'xpub',
    direction,
    type: 'onchain',
    amount_sats,
    description: null,
    counterparty,
    status: tx.status.confirmed ? 'CONFIRMED' : 'PENDING',
    timestamp: ts,
    source_wallet_id: SOURCE_WALLET_ID,
  };
}

// ─── Adapter implementation ──────────────────────────────────────────────

async function discover(credentials: Record<string, unknown>): Promise<DiscoveredWallet[]> {
  // xpub yields exactly one logical wallet — the wallet IS the xpub. We
  // still return a discovered wallet entry so the existing UI flow (pick
  // wallets → save selection → sync) works unchanged. UIs MAY auto-select
  // when `multiWallet === false` to skip the picker.
  const { xpub } = parseXpubCredentials(credentials);
  // Validate parseability now so an obviously-bad xpub fails at "discover"
  // time (clear UX) rather than at first sync.
  normalizeExtendedPubkey(xpub);
  return [
    {
      external_wallet_id: SOURCE_WALLET_ID,
      currency: 'BTC',
      label: 'Bitcoin (xpub)',
    },
  ];
}

async function syncByWallets(
  credentials: Record<string, unknown>,
  walletIds: string[],
  _cursor: string | null,
): Promise<SyncResult> {
  if (walletIds.length === 0) return { transactions: [], next_cursor: null };
  // xpub has only one logical wallet; ignore wallet selection beyond the
  // existence check (caller picked the single wallet we offered).
  return runFullScan(credentials);
}

async function syncAccountWide(
  credentials: Record<string, unknown>,
  _cursor: string | null,
): Promise<SyncResult> {
  return runFullScan(credentials);
}

/**
 * Shared sync path — derive addresses, scan both chains, dedup txs, normalize.
 */
async function runFullScan(credentials: Record<string, unknown>): Promise<SyncResult> {
  const { xpub: rawXpub, gap_limit } = parseXpubCredentials(credentials);
  const { canonicalXpub, scriptType } = normalizeExtendedPubkey(rawXpub);

  const hdRoot = HDKey.fromExtendedKey(canonicalXpub);
  if (hdRoot.privateKey) {
    // Defense: caller passed an xprv by mistake. We refuse to handle private
    // keys — even though they'd technically work for derivation, accepting
    // them changes the trust model from "watch-only" to "keys-on-server".
    throw new Error('[xpub] private extended key (xprv) not allowed — use the watch-only xpub');
  }

  const [receiveResults, changeResults] = await Promise.all([
    scanChain(hdRoot, 0, gap_limit, scriptType),
    scanChain(hdRoot, 1, gap_limit, scriptType),
  ]);

  const ourAddrs = new Set<string>([
    ...receiveResults.keys(),
    ...changeResults.keys(),
  ]);

  // Dedup tx by txid across both chains. A tx can hit multiple of our
  // addresses (e.g., spend from receive #3, change to change #7) — we want
  // a single NormalizedTransaction per unique on-chain tx.
  const txByTxid = new Map<string, MempoolTx>();
  for (const txList of receiveResults.values()) {
    for (const tx of txList) txByTxid.set(tx.txid, tx);
  }
  for (const txList of changeResults.values()) {
    for (const tx of txList) txByTxid.set(tx.txid, tx);
  }

  const transactions: NormalizedTransaction[] = [];
  for (const tx of txByTxid.values()) {
    const norm = normalizeXpubTx(tx, ourAddrs);
    if (norm) transactions.push(norm);
  }

  // Sort newest first (consistent with Blink path).
  transactions.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

  // No cursor in v1 — every sync re-scans. Consumer's (connection_id,
  // external_id) UNIQUE constraint provides dedup on the persistence side.
  return { transactions, next_cursor: null };
}

export const xpubAdapter: ProviderAdapter = {
  slug: 'xpub',
  displayName: 'Bitcoin xpub',
  description: 'On-chain watch-only',
  status: 'live',
  category: 'on_chain_wallet',
  tags: ['on-chain', 'watch-only', 'self-custody', 'sparrow', 'specter', 'bluewallet'],
  popularity: 80,
  multiWallet: false,
  credentialFields: [
    {
      name: 'xpub',
      type: 'string',
      label: 'Extended public key',
      placeholder: 'xpub… / ypub… / zpub…',
      multiline: true,
      // helpLabel renders inline under the textarea; helpHref activates
      // the orange "How to get your credentials" banner above the form.
      helpLabel: 'How to export your xpub',
      helpHref: 'https://orangerails.com/docs/xpub-export',
    },
    {
      name: 'gap_limit',
      type: 'string',
      label: 'Gap limit (advanced)',
      placeholder: '20',
      optional: true,
    },
  ],
  discoverWallets: discover,
  syncByWallets,
  syncAccountWide,
};
