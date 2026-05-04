/**
 * Stealth Sync — cross-domain postMessage protocol
 *
 * This file is the canonical contract between any consuming app
 * (V2, V3, Orange Way, future third-party SaaS) and the OR Connect widget
 * popup at https://connect.orangerails.com/connect.
 *
 * The widget runs in the user's browser on the orangerails.com origin.
 * The consuming app runs on its own origin. Cross-window postMessage
 * is the only channel between them. orangerails.com's server cannot
 * see what flows over postMessage.
 *
 * Trust model:
 * - The consuming app derives an `or_stealth_key_b64` from the user's
 *   per-app vault MEK using HKDF-SHA-256 with info='or-stealth-v1'.
 * - That key is sent to the widget popup over postMessage and used by
 *   the widget for all sealing/unsealing of envelopes and transactions.
 * - The key is held by the widget as a non-extractable CryptoKey wrapper
 *   for the duration of the popup session.
 * - The widget never makes a network request that includes the key.
 *
 * Anyone can integrate Stealth Sync by:
 *   1. Opening a popup at https://connect.orangerails.com/connect
 *   2. Listening for OR_STEALTH_READY
 *   3. Sending OR_STEALTH_INIT with the per-app key
 *   4. Listening for OR_STEALTH_PROGRESS / OR_STEALTH_ADD_COMPLETE /
 *      OR_STEALTH_SYNC_COMPLETE / OR_STEALTH_ERROR
 *   5. Closing the popup
 *
 * Spec lives in STEALTH-SYNC-MASTER-PLAN.md §4.4.
 */

export const STEALTH_PROTOCOL_VERSION = 1 as const;
export const STEALTH_HKDF_INFO = 'or-stealth-v1' as const;

// ─────────────────────────────────────────────────────────────────────
// App → Widget messages
// ─────────────────────────────────────────────────────────────────────

export type StealthMode = 'add' | 'sync' | 'list' | 'delete';

export interface StealthInitMessage {
  type: 'OR_STEALTH_INIT';
  protocol_version: typeof STEALTH_PROTOCOL_VERSION;
  app_slug: 'v2' | 'v3' | 'ow' | string;
  app_user_id: string;
  mode: StealthMode;
  /** Required for sync, list, delete. Omitted for add. */
  connection_id?: string;
  /**
   * 32 raw bytes of the per-app HKDF subkey, base64-encoded.
   * HKDF-SHA-256(input=appMEK, salt='', info='or-stealth-v1', length=32).
   * The widget treats this as a non-extractable CryptoKey internally
   * and never sends it to orangerails.com's server.
   */
  or_stealth_key_b64: string;
  /** Where the widget posts replies. Must match window.opener.location.origin. */
  return_callback_origin: string;
  /** Locale tag, e.g. 'en-US', 'fr-CA'. Drives the transparency modal copy. */
  locale?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Widget → App messages
// ─────────────────────────────────────────────────────────────────────

export interface StealthReadyMessage {
  type: 'OR_STEALTH_READY';
  protocol_version: typeof STEALTH_PROTOCOL_VERSION;
}

export type StealthStage =
  | 'unlocking'
  | 'deriving'
  | 'fetching_filters'
  | 'matching'
  | 'fetching_blocks'
  | 'building_txs'
  | 'sealing'
  | 'uploading';

export interface StealthProgressMessage {
  type: 'OR_STEALTH_PROGRESS';
  stage: StealthStage;
  /** 0 to 100. */
  percent: number;
  /** User-facing copy in the requested locale. */
  message: string;
  /** Optional second line, plain English. */
  detail?: string;
  eta_seconds?: number;
}

export interface StealthAddCompleteMessage {
  type: 'OR_STEALTH_ADD_COMPLETE';
  connection_id: string;
  /** ISO-8601 date, e.g. '2021-01-15'. */
  wallet_birthday: string;
  label: string;
  /** Detected script type for the consuming app to display. */
  script_type:
    | 'p2pkh'
    | 'p2sh-p2wpkh'
    | 'p2wpkh'
    | 'p2tr'
    | 'multisig-descriptor';
}

/** A sealed transaction record. The widget builds these client-side. */
export interface SealedTransaction {
  version: 1;
  algorithm: 'AES-256-GCM';
  iv_b64: string;
  ciphertext_b64: string;
  /** Plaintext occurred_at for indexed range queries. ZKA Level 2. */
  occurred_at: string;
  /** Plaintext block height for resume on the next sync. */
  block_height: number;
  /** HMAC of txid under the per-app key. Server cannot reverse. */
  txid_blind_index_b64: string;
}

export interface StealthSyncCompleteMessage {
  type: 'OR_STEALTH_SYNC_COMPLETE';
  connection_id: string;
  sealed_transactions: SealedTransaction[];
  last_block_scanned: number;
  tx_count: number;
  /** Useful for the consuming app to show "downloaded X MB". */
  bytes_downloaded: number;
  /** Wall-clock seconds from INIT to this message. */
  duration_seconds: number;
}

export interface StealthListResultMessage {
  type: 'OR_STEALTH_LIST_RESULT';
  connections: Array<{
    connection_id: string;
    label: string;
    wallet_birthday: string;
    last_sync_at: string | null;
    status: 'active' | 'error' | 'archived';
    tx_count: number;
  }>;
}

export interface StealthDeleteCompleteMessage {
  type: 'OR_STEALTH_DELETE_COMPLETE';
  connection_id: string;
}

export type StealthErrorCode =
  | 'INVALID_XPUB'
  | 'INVALID_DESCRIPTOR'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'KEY_MISMATCH'
  | 'CONNECTION_NOT_FOUND'
  | 'ORIGIN_NOT_ALLOWED'
  | 'PROTOCOL_VERSION_MISMATCH'
  | 'INTERNAL';

export interface StealthErrorMessage {
  type: 'OR_STEALTH_ERROR';
  code: StealthErrorCode;
  message: string;
  retryable: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// Discriminated unions for type-safe handlers
// ─────────────────────────────────────────────────────────────────────

export type StealthMessageFromApp = StealthInitMessage;

export type StealthMessageFromWidget =
  | StealthReadyMessage
  | StealthProgressMessage
  | StealthAddCompleteMessage
  | StealthSyncCompleteMessage
  | StealthListResultMessage
  | StealthDeleteCompleteMessage
  | StealthErrorMessage;

// ─────────────────────────────────────────────────────────────────────
// Sealed envelope (the unit OR stores at rest)
// ─────────────────────────────────────────────────────────────────────

export interface SealedEnvelope {
  version: 1;
  algorithm: 'AES-256-GCM';
  iv_b64: string;
  ciphertext_b64: string;
  /**
   * Plaintext schema, before encryption, is JSON.stringify of one of:
   *   {
   *     kind: 'xpub_stealth',
   *     xpub: string,
   *     label: string,
   *     wallet_birthday: string,    // ISO date
   *     gap_limit: number,          // default 20
   *     script_type: 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh' | 'p2tr'
   *   }
   *   {
   *     kind: 'descriptor_stealth',
   *     descriptor: string,         // e.g. wsh(multi(2,xpub.../0/*,...))
   *     label: string,
   *     wallet_birthday: string,
   *     gap_limit: number
   *   }
   * BIP47 (kind: 'bip47_stealth') is reserved for v2.
   */
}

// ─────────────────────────────────────────────────────────────────────
// Helpers consuming apps can copy
// ─────────────────────────────────────────────────────────────────────

/**
 * Derive the per-app stealth subkey from the consuming app's MEK.
 * The MEK must be a CryptoKey with extractable=false (best practice)
 * but exportKey('raw') is required to feed HKDF; some implementations
 * keep the MEK extractable for exactly this reason. Treat the derived
 * key bytes as a transient secret in browser memory only.
 */
export async function deriveOrStealthKey(mek: CryptoKey): Promise<string> {
  const mekBytes = new Uint8Array(await crypto.subtle.exportKey('raw', mek));
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    mekBytes,
    'HKDF',
    false,
    ['deriveBits'],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(STEALTH_HKDF_INFO),
    },
    hkdfKey,
    256,
  );
  // Wipe mekBytes from memory best-effort
  mekBytes.fill(0);
  return btoa(String.fromCharCode(...new Uint8Array(derived)));
}

/**
 * Open the OR Connect widget popup and return a typed message bus.
 * Consuming apps call this when the user clicks Add or Sync.
 */
export function openStealthWidget(opts: {
  base_url?: string;     // default 'https://connect.orangerails.com'
  init: StealthInitMessage;
  on_message: (m: StealthMessageFromWidget) => void;
  on_close?: () => void;
  width?: number;        // default 480
  height?: number;       // default 720
}): { close: () => void; popup: Window | null } {
  const base = opts.base_url ?? 'https://connect.orangerails.com';
  const url = `${base}/connect?mode=${opts.init.mode}&app=${opts.init.app_slug}`;
  const features = `width=${opts.width ?? 480},height=${opts.height ?? 720},menubar=no,toolbar=no,location=no,status=no`;
  const popup = window.open(url, 'or-stealth-widget', features);

  const handler = (e: MessageEvent) => {
    if (e.origin !== base) return;
    const msg = e.data as StealthMessageFromWidget;
    if (msg?.type === 'OR_STEALTH_READY') {
      popup?.postMessage(opts.init, base);
      return;
    }
    opts.on_message(msg);
  };
  window.addEventListener('message', handler);

  const close = () => {
    window.removeEventListener('message', handler);
    popup?.close();
    opts.on_close?.();
  };

  // Best-effort detection of the user closing the popup manually.
  const interval = setInterval(() => {
    if (popup?.closed) {
      clearInterval(interval);
      close();
    }
  }, 500);

  return { close, popup };
}
