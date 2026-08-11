/**
 * xpub source adapter , watch-only on-chain Bitcoin wallet via extended public key.
 *
 * Listed as PLANNED in OrangeRails-Protocol.html §18 ("Mempool xpub"). The
 * appeal is no API key, no upstream account, no OAuth flow , paste the xpub
 * and OR scans on-chain. Works for any wallet that exposes its xpub
 * (Sparrow, Specter, Electrum, hardware wallets, BlueWallet, etc.).
 *
 * Supported prefixes (mainnet only in v1):
 *   - xpub (BIP44, P2PKH legacy)
 *   - ypub (BIP49, P2SH-P2WPKH wrapped segwit)
 *   - zpub (BIP84, P2WPKH native segwit)
 *
 * Prefix handling and canonicalization live in ./canonical.ts, which is pure and
 * separately tested, because the shared connector identity module needs the
 * canonical key without needing this adapter's network client.
 *
 * Not yet supported (v1 limitations , easy to add when a user needs them):
 *   - BIP86 P2TR (`xpub` with derivation hint, or descriptors)
 *   - Multisig (Ypub/Zpub uppercase = multisig variants)
 *   - Testnet (tpub/upub/vpub) , same code path, just version-bytes table
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
 * effort to paginate older history , if a user has >50 confirmed txs at a
 * single address (very rare for personal wallets) we miss the older ones
 * until v1.1 adds /chain/{txid} pagination.
 *
 * Cursor: unused in v1 , every sync re-scans all addresses. The consumer's
 * (connection_id, external_id) UNIQUE constraint dedups; OR's caller-side
 * idempotence makes this safe but wasteful. v1.1 will switch to
 * cursor = max block_height seen so we can short-circuit once a tx batch
 * is fully below the cursor.
 */

import { HDKey } from 'https://esm.sh/@scure/bip32@1.4.0';
import * as btc from 'https://esm.sh/@scure/btc-signer@1.3.2';
import { hmac } from 'https://esm.sh/@noble/hashes@1.4.0/hmac';
import { sha256 } from 'https://esm.sh/@noble/hashes@1.4.0/sha256';

import { normalizeExtendedPubkey, type ScriptType } from './canonical.ts';

import type {
  ProviderAdapter,
  DiscoveredWallet,
  NormalizedTransaction,
  SyncResult,
} from '../types.ts';

// --- Constants ----------------------------------------------------------

const MEMPOOL_API = 'https://mempool.space/api';
const DEFAULT_GAP_LIMIT = 20;          // BIP44 standard
const MAX_ADDRESSES_PER_CHAIN = 500;   // safety cap

// --- Credential parsing -------------------------------------------------

interface XpubCredentials {
  xpub: string;
  // Always populated by parseXpubCredentials (clamped input or DEFAULT_GAP_LIMIT),
  // so it is non-optional: scanChain and every other caller can rely on a number.
  gap_limit: number;
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

// --- Wallet identity: fingerprint + opaque ID ---------------------------

const BASE58_ALPHABET_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Compute an HMAC-SHA256 fingerprint for an xpub/ypub/zpub string.
 *
 * This is the INTERNAL wallet identity key. It is stored in
 * source_wallets.wallet_fingerprint for dedup on reconnect and must
 * NEVER appear in any external API response body, edge-function log
 * line, or error message. Only the separately-generated opaque UUID
 * (see generateOpaqueWalletId) is returned to callers.
 *
 * Algorithm: trim() the raw string, reject non-base58 chars,
 * HMAC-SHA256 with the server secret loaded from WALLET_ID_HMAC_KEY
 * (64 hex chars = 32 bytes). The keyed MAC ensures that even an
 * attacker who holds the raw xpub cannot correlate users across
 * servers or brute-force which fingerprint belongs to which key.
 *
 * Normalization matches Finding 1: trim() + base58 guard over the
 * full input string (including prefix). SLIP-132 variants (xpub,
 * ypub, zpub) produce distinct fingerprints because their prefixes
 * differ, matching the prefix-aware hashing established in Finding 1.
 *
 * KEY STABILITY: WALLET_ID_HMAC_KEY must be treated as a permanent
 * server secret. Rotating it silently breaks dedup: the same xpub
 * yields a new fingerprint, the unique index on source_wallets does
 * not catch the collision (that constraint covers external_wallet_id,
 * the opaque UUID, not wallet_fingerprint), and a duplicate wallet row
 * is created for the reconnected user. Any future key rotation requires
 * re-fingerprinting every existing source_wallets.wallet_fingerprint
 * row in a coordinated migration before the new key goes live.
 */
function xpubToWalletFingerprint(rawXpub: string): string {
  const key = rawXpub.trim();
  if (!BASE58_ALPHABET_RE.test(key)) {
    throw new Error(
      '[xpub] extended public key contains non-base58 characters: check for whitespace or copy-paste artifacts',
    );
  }
  const keyHex = Deno.env.get('WALLET_ID_HMAC_KEY');
  if (!keyHex) {
    throw new Error('[xpub] WALLET_ID_HMAC_KEY environment variable is not set');
  }
  if (keyHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(keyHex)) {
    throw new Error(
      '[xpub] WALLET_ID_HMAC_KEY must be 64 hex characters (32 bytes). Generate with: openssl rand -hex 32',
    );
  }
  const keyBytes = Uint8Array.from(
    { length: 32 },
    (_, i) => parseInt(keyHex.slice(i * 2, i * 2 + 2), 16),
  );
  const mac = hmac(sha256, keyBytes, new TextEncoder().encode(key));
  return Array.from(mac)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate a cryptographically random opaque wallet ID.
 *
 * This UUID v4 is stored as source_wallets.external_wallet_id and is
 * the value passed back to the adapter on subsequent sync calls as
 * source_wallet_id. It has zero derivable relationship to the
 * underlying xpub: an external observer holding the raw extended
 * public key learns nothing from seeing this value.
 *
 * Deduplication on reconnect is handled by the persistence layer via
 * wallet_fingerprint (from xpubToWalletFingerprint), not by this value.
 */
function generateOpaqueWalletId(): string {
  return crypto.randomUUID();
}

// --- Address derivation -------------------------------------------------

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

// --- Mempool.space client -----------------------------------------------

interface MempoolVin {
  prevout?: { scriptpubkey_address?: string; value: number; };
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
  status: { confirmed: boolean; block_height?: number; block_time?: number; };
}

async function fetchAddressTxs(address: string): Promise<MempoolTx[]> {
  const res = await fetch(`${MEMPOOL_API}/address/${address}/txs`);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 404) return [];
    throw new Error(`mempool.space ${res.status} for ${address}: ${detail.slice(0, 120)}`);
  }
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error(`mempool.space returned non-array for ${address}`);
  return json as MempoolTx[];
}

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

// --- Tx normalization ---------------------------------------------------

function normalizeXpubTx(
  tx: MempoolTx,
  ourAddrs: Set<string>,
  walletId: string | null,
): NormalizedTransaction | null {
  let ourIn = 0;
  let ourOut = 0;
  let firstExternalVinAddr: string | null = null;
  let firstExternalVoutAddr: string | null = null;

  for (const vin of tx.vin) {
    const addr = vin.prevout?.scriptpubkey_address;
    const value = vin.prevout?.value ?? 0;
    if (addr && ourAddrs.has(addr)) { ourIn += value; }
    else if (addr && !firstExternalVinAddr) { firstExternalVinAddr = addr; }
  }
  for (const vout of tx.vout) {
    const addr = vout.scriptpubkey_address;
    if (addr && ourAddrs.has(addr)) { ourOut += vout.value; }
    else if (addr && !firstExternalVoutAddr) { firstExternalVoutAddr = addr; }
  }

  if (ourIn === 0 && ourOut === 0) return null;

  let direction: 'in' | 'out';
  let amount_sats: number;
  let counterparty: string | null;

  if (ourIn === 0) {
    direction = 'in';
    amount_sats = ourOut;
    counterparty = firstExternalVinAddr;
  } else {
    direction = 'out';
    amount_sats = ourIn - ourOut;
    counterparty = firstExternalVoutAddr;
  }

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
    source_wallet_id: walletId,
  };
}

// --- Adapter implementation ---------------------------------------------

async function discover(credentials: Record<string, unknown>): Promise<DiscoveredWallet[]> {
  const { xpub } = parseXpubCredentials(credentials);
  normalizeExtendedPubkey(xpub);                   // validates prefix + decodability
  const fingerprint = xpubToWalletFingerprint(xpub);
  const opaqueId = generateOpaqueWalletId();
  return [
    {
      external_wallet_id: opaqueId,
      wallet_fingerprint: fingerprint,
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
  return runFullScan(credentials, walletIds[0]);
}

async function syncAccountWide(
  credentials: Record<string, unknown>,
  _cursor: string | null,
): Promise<SyncResult> {
  return runFullScan(credentials, null);
}

async function runFullScan(
  credentials: Record<string, unknown>,
  walletId: string | null,
): Promise<SyncResult> {
  const { xpub: rawXpub, gap_limit } = parseXpubCredentials(credentials);
  const { canonicalXpub, scriptType } = normalizeExtendedPubkey(rawXpub);

  const hdRoot = HDKey.fromExtendedKey(canonicalXpub);
  if (hdRoot.privateKey) {
    throw new Error('[xpub] private extended key (xprv) not allowed , use the watch-only xpub');
  }

  const [receiveResults, changeResults] = await Promise.all([
    scanChain(hdRoot, 0, gap_limit, scriptType),
    scanChain(hdRoot, 1, gap_limit, scriptType),
  ]);

  const ourAddrs = new Set<string>([...receiveResults.keys(), ...changeResults.keys()]);

  const txByTxid = new Map<string, MempoolTx>();
  for (const txList of receiveResults.values()) for (const tx of txList) txByTxid.set(tx.txid, tx);
  for (const txList of changeResults.values()) for (const tx of txList) txByTxid.set(tx.txid, tx);

  const transactions: NormalizedTransaction[] = [];
  for (const tx of txByTxid.values()) {
    const norm = normalizeXpubTx(tx, ourAddrs, walletId);
    if (norm) transactions.push(norm);
  }

  transactions.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return { transactions, next_cursor: null };
}

export const xpubAdapter: ProviderAdapter = {
  slug: 'xpub',
  displayName: 'Bitcoin xpub',
  description: 'On-chain watch-only',
  status: 'live',
  category: 'on_chain_wallet',
  tags: ['on-chain', 'watch-only', 'self-custody', 'sparrow', 'specter', 'bluewallet'],
  custody: 'self_custody',
  popularity: 80,
  multiWallet: false,
  // Route the tile to the Stealth Sync flow, which scans in the browser and
  // never sends addresses to the server. Reuses the path the Sparrow tile
  // already takes: /connect/sparrow opens /connect/stealth in a popup.
  // Without this the tile falls through to the credential form and creates a
  // server side connection on the legacy path.
  connectUrl: '/connect/sparrow',
  credentialFields: [
    {
      name: 'xpub',
      type: 'string',
      label: 'Extended public key',
      placeholder: 'xpub... / ypub... / zpub...',
      multiline: true,
      helpLabel: 'How to export your xpub',
      // Relative path resolves correctly in every environment (dev, staging, prod).
      // The absolute production URL caused 404s on non-prod deploys.
      helpHref: '/docs/xpub-export',
    },
    // gap_limit removed from the form: the BIP44 default (20) is correct
    // for virtually all personal wallets and exposing it confused users.
    // The server defaults to 20 in parseXpubCredentials when the field is absent.
  ],
  discoverWallets: discover,
  syncByWallets,
  syncAccountWide,
};
