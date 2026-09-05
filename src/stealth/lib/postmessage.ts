/**
 * Stealth Sync , cross-domain postMessage protocol
 *
 * This file is the canonical contract between any consuming app
 * (V2, V3, Orange Way, future third-party SaaS) and the OR Connect widget
 * popup at https://connect.orangerails.com/connect/stealth.
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
 * seal_mode='app' (new):
 * - The consuming app is the authoritative sealing store.
 * - The widget receives NO key: or_stealth_key_b64 is typed `never` on
 *   StealthInitAppMessage, refused by the sender in openStealthWidget, and
 *   rejected again at runtime by the widget if it somehow arrives.
 * - The widget scans and returns plaintext provenance records
 *   (StealthTransactionProvenance) for the app to seal under its own key.
 * - The widget does not seal or POST any envelope.
 * - The app-mode ROUTES are follow-on work. Until they land, the widget
 *   rejects seal_mode='app' at INIT with an explicit not-implemented error
 *   rather than letting a keyless init fall into widget-mode crypto.
 *
 * Anyone can integrate Stealth Sync by:
 *   1. Opening a popup at https://connect.orangerails.com/connect/stealth
 *   2. Listening for OR_STEALTH_READY
 *   3. Sending OR_STEALTH_INIT with the per-app key (widget mode)
 *      or without any key (app mode)
 *   4. Listening for OR_STEALTH_PROGRESS / OR_STEALTH_ADD_COMPLETE /
 *      OR_STEALTH_SYNC_COMPLETE / OR_STEALTH_ERROR
 *   5. Closing the popup
 *
 * Note on routes: `/connect/stealth` is this widget. `/connect` is the
 * older Link widget (provider credentials, bank connections) with a
 * different key-handoff model. Do not open `/connect` for the xpub or
 * descriptor flow.
 *
 * Spec lives in STEALTH-SYNC-MASTER-PLAN.md §4.4.
 */

export const STEALTH_PROTOCOL_VERSION = 1 as const;

/**
 * The full set of protocol versions this widget build accepts at INIT and
 * advertises in READY. Membership, not equality, is the compatibility rule:
 * an INIT whose protocol_version is anywhere in this set is accepted, and an
 * app can read this set off READY to pick a version both sides speak with no
 * app deploy. STEALTH_PROTOCOL_VERSION stays the current preferred version.
 *
 * This PR ships the mechanism only. The set stays [1] here; a version is
 * added to it only in the release that actually bumps the protocol, per the
 * 90 day deprecation window documented in docs/Stealth-Sync.md.
 */
export const STEALTH_SUPPORTED_PROTOCOL_VERSIONS = [1] as const;

/**
 * Union of every version this widget build accepts. Derived from
 * STEALTH_SUPPORTED_PROTOCOL_VERSIONS so that adding a version to the array
 * widens this type automatically, with no second place to edit.
 */
export type StealthProtocolVersion = (typeof STEALTH_SUPPORTED_PROTOCOL_VERSIONS)[number];

export const STEALTH_HKDF_INFO = 'or-stealth-v1' as const;

/**
 * Default gap limit used when OR_STEALTH_INIT omits the field.
 *
 * Raised to 250 based on benchmark run 30698208747 (bench/gcs-match-cost*,
 * benches/gcs_match_cost.mjs). All three sweep points passed the 5ms/block
 * veto on fixed-window cost:
 *   gap_limit=20    median=0.757ms  p95=1.803ms  PASS
 *   gap_limit=250   median=1.080ms  p95=2.241ms  PASS
 *   gap_limit=1000  median=1.965ms  p95=3.127ms  PASS
 *
 * Cost curve is GCS decode dominated, not script-count dominated.
 * 50x more scripts (80 to 1000) costs only 2.19x more per block.
 *
 * The old default of 20 caused silent address-window exhaustion for
 * Sparrow wallets using address indices beyond gap 20 (the Marina/Fedi
 * escalation). See issue #357.
 *
 * Rolling-window (K-pass, #398) cost is not yet measured by this harness.
 * If that measurement changes the picture, raise a follow-up against this
 * constant.
 */
export const DEFAULT_GAP_LIMIT = 250 as const;

/** Path the Stealth Sync widget is mounted at. See src/routes/connect/stealth.tsx. */
export const STEALTH_WIDGET_PATH = '/connect/stealth' as const;

/**
 * Thrown by openStealthWidget when an app-mode init carries key material.
 * App mode means the key never leaves the consuming app's origin, so this
 * is refused at the sender, before the popup exists and before any
 * postMessage crosses to the widget origin.
 */
export class StealthKeyLeakError extends Error {
  constructor() {
    super(
      "seal_mode='app' must not carry or_stealth_key_b64: in app mode the key " +
        "never leaves the consuming app's origin.",
    );
    this.name = 'StealthKeyLeakError';
  }
}

// ─────────────────────────────────────────────────────────────────────
// App → Widget messages
// ─────────────────────────────────────────────────────────────────────

export type StealthMode = 'add' | 'sync' | 'list' | 'delete';

/**
 * Widget mode (default, backward-compatible).
 *
 * or_stealth_key_b64 is required. The widget seals envelopes and
 * transactions on behalf of the user and stores ciphertext at OR's
 * origin. The server holds ciphertext only; it cannot unseal anything.
 *
 * Narrow on: seal_mode === 'widget' or seal_mode absent.
 */
export interface StealthInitWidgetMessage {
  type: 'OR_STEALTH_INIT';
  /** Absent or 'widget' both resolve to widget mode. */
  seal_mode?: 'widget';
  protocol_version: StealthProtocolVersion;
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
   * Required in widget mode. Typed `never` in app mode.
   */
  or_stealth_key_b64: string;
  /** Where the widget posts replies. Must match window.opener.location.origin. */
  return_callback_origin: string;
  /** Locale tag, e.g. 'en-US', 'fr-CA'. Drives the transparency modal copy. */
  locale?: string;
  /**
   * Auth mode A (preferred for apps that already run a backend).
   * When set, the widget does not call OR's edge functions directly.
   * It posts OR_STEALTH_PROXY_REQUEST to the parent, and the parent makes
   * the call server-side and attaches the platform API key there, so that
   * key never reaches the browser. See routes/add.tsx and lib/proxyFetch.ts.
   */
  proxy_base_url?: string;
  /**
   * Auth mode B (direct). A Supabase JWT the widget sends as
   * `Authorization: Bearer <token>` on the edge-function POST. Only used
   * when `proxy_base_url` is absent. This is an access token for OR's API,
   * never a key that can unseal anything.
   */
  access_token?: string;
  /**
   * Auth mode C (widget token). The short-lived session id the host app's
   * backend minted via or-link-mint-token before opening the widget. Sent in
   * the POST BODY, not as a header.
   *
   * For a host app whose users have no OrangeRails account there is no
   * Supabase JWT to put in mode B, and mode A needs a backend proxy the app
   * may not have. This is the credential that path already holds, and the
   * same one or-discover-wallets and or-link-complete already accept.
   *
   * Ignored when `proxy_base_url` is set: the proxy attaches the platform key
   * server-side, which outranks it. Like `access_token`, this is an access
   * credential for OR's API and can unseal nothing.
   */
  widget_token?: string;
  /** Optional: when true, the widget skips uploading sealed transactions
   *  to OR's `or-stealth-transactions-store` endpoint. Used by consumer
   *  apps that hold their own source-of-truth copy and do not need OR's
   *  encrypted backup (V2 today). The wallet envelope is still stored
   *  at OR (required for cross-device sync); only the per-tx records
   *  are skipped. */
  skip_transaction_upload?: boolean;
  /**
   * Optional address gap limit (integer, 1-1000). When present, seeds the
   * gap-limit field in the add-route form (the user can still override it).
   * When absent the widget uses DEFAULT_GAP_LIMIT.
   *
   * Out-of-range values (non-integer, < 1, or > 1000) are rejected at INIT
   * with code INVALID_GAP_LIMIT and a descriptive message rather than silently clamped.
   *
   * This affects only connections created after the INIT. Existing sealed
   * connections retain the gap_limit baked into their envelope at add-time;
   * a changed default cannot reach into a sealed envelope.
   */
  gap_limit?: number;
  /**
   * Delivery acknowledgement gate (DL-0807). Only honoured when
   * skip_transaction_upload is also true.
   *
   * When set, the widget posts SYNC_COMPLETE with pending_delivery_ack: true
   * BEFORE advancing the sync cursor. The consuming app must then post
   * OR_STEALTH_DELIVERY_ACK to confirm it saved the sealed transactions. Only
   * after that ack does the widget write the cursor via
   * or-stealth-envelope-update. If the ack does not arrive within 30 seconds,
   * the widget fires OR_STEALTH_ERROR with code DELIVERY_ACK_MISSING
   * (retryable: true) and leaves the cursor unchanged so the next sync
   * re-scans safely.
   */
  require_delivery_ack?: boolean;
}

/**
 * App mode. The consuming app is the authoritative sealing store.
 *
 * The widget receives NO key. `or_stealth_key_b64?: never` is deliberate and
 * stronger than omitting the field: omission is only enforced by excess-property
 * checking, which TypeScript applies to fresh object literals and NOT to spreads.
 * Typing it `never` makes `{ ...widgetInit, seal_mode: 'app' as const }` a compile
 * error too, so the key is unrepresentable on this variant by any construction.
 * Sending it anyway is refused by openStealthWidget at the sender and rejected
 * again by the widget at runtime with code INTERNAL.
 *
 * The widget scans and validates the xpub/descriptor, then returns
 * StealthTransactionProvenance records for the app to seal under its own
 * key. The widget does not seal or POST any envelope to OR's origin.
 *
 * Narrow on: seal_mode === 'app'.
 */
export interface StealthInitAppMessage {
  type: 'OR_STEALTH_INIT';
  /** Required discriminant for app mode. */
  seal_mode: 'app';
  protocol_version: StealthProtocolVersion;
  app_slug: 'v2' | 'v3' | 'ow' | string;
  app_user_id: string;
  mode: StealthMode;
  /** Required for sync, list, delete. Omitted for add. */
  connection_id?: string;
  /**
   * Unrepresentable in app mode. The widget receives no key: there is no
   * value of type `never`, so this field can never be populated, not by a
   * literal and not by a spread.
   */
  or_stealth_key_b64?: never;
  /** Where the widget posts replies. Must match window.opener.location.origin. */
  return_callback_origin: string;
  /** Locale tag, e.g. 'en-US', 'fr-CA'. Drives the transparency modal copy. */
  locale?: string;
  /** Auth mode A: parent-proxy round trip. See StealthInitWidgetMessage. */
  proxy_base_url?: string;
  /** Auth mode B: direct Supabase JWT. See StealthInitWidgetMessage. */
  access_token?: string;
  /**
   * Optional address gap limit. Same contract as StealthInitWidgetMessage.
   * App mode supports this field for parity with widget mode.
   */
  gap_limit?: number;
}

/**
 * Discriminated union for OR_STEALTH_INIT.
 *
 * Narrow by seal_mode:
 *   seal_mode === 'app'                 -> StealthInitAppMessage (no key)
 *   seal_mode === 'widget' or absent    -> StealthInitWidgetMessage (key required)
 *
 * The 'app' variant cannot carry or_stealth_key_b64: the field is typed `never`,
 * so it is unrepresentable through literals and spreads alike.
 * The 'widget' variant requires or_stealth_key_b64.
 */
export type StealthInitMessage = StealthInitWidgetMessage | StealthInitAppMessage;

// ─────────────────────────────────────────────────────────────────────
// Widget → App messages
// ─────────────────────────────────────────────────────────────────────

export interface StealthReadyMessage {
  type: 'OR_STEALTH_READY';
  /** Current preferred version. Prefer supported_protocol_versions when picking a version to speak. */
  protocol_version: StealthProtocolVersion;
  /**
   * Every protocol version this widget build accepts at INIT, in ascending
   * order. Added additively (DEC-0304): an app that reads only
   * protocol_version is unaffected. Read this set to pick a version both
   * sides speak with no app deploy, including after a widget rollback or a
   * stale cached copy is served.
   */
  supported_protocol_versions: readonly number[];
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

/** A sealed transaction record. The widget builds these in widget mode only. */
export interface SealedTransaction {
  version: 1;
  algorithm: 'AES-256-GCM';
  iv_b64: string;
  ciphertext_b64: string;
  /** Plaintext occurred_at for indexed range queries. ZKA Level 2. */
  occurred_at: string;
  /** Plaintext block height for resume on the next sync. */
  block_height: number;
  /**
   * Hex, RPC display order: the canonical hash of the block at block_height,
   * as read from the BIP158 filter record that matched this transaction.
   *
   * Plaintext, deliberately. The server already holds block_height in
   * plaintext, and the mapping from a height to a block hash is public chain
   * data, so the hash says nothing about the customer that the height did not
   * already say. What it buys is the ability to notice that the block this
   * transaction was read from is no longer on the chain, which a height on its
   * own can never show, and to notice it without holding the customer's key.
   *
   * Optional. Absent from records produced by widget builds older than this
   * field, and those records are permanently unverifiable rather than wrong.
   */
  block_hash_hex?: string;
  /**
   * Lowercase hex HMAC-SHA-256 of txid under the per-app blind-index subkey.
   * Server cannot reverse: the subkey is derived from the per-app stealth key
   * (HKDF-SHA-256, info="or-stealth/blind-index/v1"), which the server never holds.
   */
  txid_blind_index_hex: string;
}

/**
 * Plaintext transaction provenance returned in app mode (seal_mode='app').
 *
 * The widget has no key in app mode and cannot seal anything. It returns
 * the raw scan result for the consuming app to seal under its own key.
 *
 * `sealed?: never` is deliberate: the app is the sealing authority, and a
 * record on this type must be unrepresentable with a sealed payload attached,
 * through spreads as well as literals.
 */
export interface StealthTransactionProvenance {
  /** Raw txid. The app should treat this as sensitive and seal it. */
  txid: string;
  /** ISO-8601 timestamp. */
  occurred_at: string;
  /** Block height for resume on the next sync. */
  block_height: number;
  // No blind index: the app derives its own under its own key.
  /** Unrepresentable: the widget holds no key and seals nothing in app mode. */
  sealed?: never;
}

/**
 * Widget mode sync result. The widget sealed the transactions and returns
 * the envelopes. sealed_transactions is present and required.
 * Narrow on: seal_mode === 'widget' or absent.
 */
export interface StealthSyncCompleteWidgetMessage {
  type: 'OR_STEALTH_SYNC_COMPLETE';
  /** Absent or 'widget' both resolve to widget mode. */
  seal_mode?: 'widget';
  connection_id: string;
  sealed_transactions: SealedTransaction[];
  last_block_scanned: number;
  tx_count: number;
  /** Useful for the consuming app to show "downloaded X MB". */
  bytes_downloaded: number;
  /** Wall-clock seconds from INIT to this message. */
  duration_seconds: number;
  /**
   * True when any matched transaction landed at or within gap_limit slots
   * of the top of the derived address window on either chain. Signals that
   * the wallet may have outgrown the current window and history could be
   * incomplete. The consuming app must prompt the user to re-sync with a
   * wider gap_limit. Absent or false means the history is complete within
   * the current window. See docs/Stealth-Sync.md for full details.
   */
  address_window_exhausted?: boolean;
  /**
   * Present when the server-side cursor write (or-stealth-envelope-update)
   * failed after a successful scan. The sync data is valid and
   * sealed_transactions is populated, but last_block_scanned was not
   * persisted to the server. The next sync will re-scan from the stored
   * cursor. The calling app should surface this as a warning; the data
   * itself is intact.
   */
  cursor_update_failed?: true;
  /**
   * Present when require_delivery_ack was set on the INIT message. Signals
   * that the cursor has NOT yet been advanced. The consuming app must post
   * OR_STEALTH_DELIVERY_ACK to the widget to confirm its own save, after
   * which the widget writes the cursor. Keeping the popup open while this
   * field is present is the recommended pattern.
   */
  pending_delivery_ack?: true;
}

/**
 * App mode sync result. The widget returns plaintext provenance records
 * for the app to seal. sealed_transactions is typed `never`, so it is
 * unrepresentable here through spreads as well as literals.
 * Narrow on: seal_mode === 'app'.
 */
export interface StealthSyncCompleteAppMessage {
  type: 'OR_STEALTH_SYNC_COMPLETE';
  /** Required discriminant for app mode. */
  seal_mode: 'app';
  connection_id: string;
  /** Plaintext provenance records. The app seals them under its own key. */
  transactions: StealthTransactionProvenance[];
  /** Unrepresentable: the widget holds no key and seals nothing in app mode. */
  sealed_transactions?: never;
  last_block_scanned: number;
  tx_count: number;
  /** Useful for the consuming app to show "downloaded X MB". */
  bytes_downloaded: number;
  /** Wall-clock seconds from INIT to this message. */
  duration_seconds: number;
  /**
   * True when any matched transaction landed at or within gap_limit slots
   * of the top of the derived address window on either chain. See the
   * widget-mode variant above for full semantics.
   */
  address_window_exhausted?: boolean;
  /**
   * Present when the server-side cursor write (or-stealth-envelope-update)
   * failed. See StealthSyncCompleteWidgetMessage.cursor_update_failed for
   * full semantics.
   */
  cursor_update_failed?: true;
}

/**
 * Discriminated union for OR_STEALTH_SYNC_COMPLETE.
 *
 * Narrow by seal_mode:
 *   seal_mode === 'app'                 -> StealthSyncCompleteAppMessage
 *                                          (transactions: StealthTransactionProvenance[],
 *                                           sealed_transactions: never, sealed: never)
 *   seal_mode === 'widget' or absent    -> StealthSyncCompleteWidgetMessage
 *                                          (sealed_transactions: SealedTransaction[])
 */
export type StealthSyncCompleteMessage = StealthSyncCompleteWidgetMessage | StealthSyncCompleteAppMessage;

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
  | 'INVALID_GAP_LIMIT'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'KEY_MISMATCH'
  | 'CONNECTION_NOT_FOUND'
  | 'ORIGIN_NOT_ALLOWED'
  | 'PROTOCOL_VERSION_MISMATCH'
  | 'WINDOW_EXHAUSTED'
  | 'DELIVERY_ACK_MISSING'
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

/**
 * App -> Widget: confirms the consuming app has saved the sealed transactions.
 * Only sent when require_delivery_ack was set on the INIT message.
 * The widget advances the sync cursor upon receiving this message.
 */
export interface StealthDeliveryAckMessage {
  type: 'OR_STEALTH_DELIVERY_ACK';
  connection_id: string;
}

export type StealthMessageFromApp =
  | StealthInitMessage
  | StealthProxyResponseMessage
  | StealthDeliveryAckMessage;

export type StealthMessageFromWidget =
  | StealthReadyMessage
  | StealthProgressMessage
  | StealthAddCompleteMessage
  | StealthSyncCompleteMessage
  | StealthListResultMessage
  | StealthDeleteCompleteMessage
  | StealthErrorMessage
  | StealthProxyRequestMessage;

// ─────────────────────────────────────────────────────────────────────
// Parent-proxy round trip (used when the consuming app hosts a server-
// side proxy and wants to keep the platform API key off the browser).
// Widget posts OR_STEALTH_PROXY_REQUEST to the parent; parent makes the
// same-origin call and posts OR_STEALTH_PROXY_RESPONSE back.
// ─────────────────────────────────────────────────────────────────────

export interface StealthProxyRequestMessage {
  type: 'OR_STEALTH_PROXY_REQUEST';
  /** Caller-generated UUID to correlate request/response. */
  request_id: string;
  /** Edge function slug (e.g. 'or-stealth-connection-create'). */
  fn: string;
  /** JSON-serializable request body forwarded as-is. */
  body: unknown;
}

export interface StealthProxyResponseMessage {
  type: 'OR_STEALTH_PROXY_RESPONSE';
  request_id: string;
  status: number;
  /** OR's response body , usually JSON object, occasionally a string on error. */
  body: unknown;
}

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
   *     gap_limit: number,          // default 250
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
 * Sender-side key discipline for app mode.
 *
 * The widget's runtime guard is defense in depth, but it runs after the key
 * has already crossed into the widget origin's memory. App mode means the key
 * never leaves the consuming app's origin, so the lock belongs on this door:
 * refuse loudly here, and hand back a copy with the field stripped so nothing
 * can ride along on a mutated object.
 *
 * Exported for tests and for apps that build their own popup plumbing.
 */
export function assertNoKeyInAppMode(init: StealthInitMessage): StealthInitMessage {
  if (init.seal_mode !== 'app') return init;

  const candidate = init as Record<string, unknown>;
  const key = candidate.or_stealth_key_b64;
  if (typeof key === 'string' && key.length > 0) {
    throw new StealthKeyLeakError();
  }

  // Strip the field entirely, even when it held a non-string or empty value.
  // What is not in the object cannot be posted across the origin boundary.
  const scrubbed: Record<string, unknown> = { ...candidate };
  delete scrubbed.or_stealth_key_b64;
  return scrubbed as unknown as StealthInitAppMessage;
}

/**
 * Open the OR Connect widget popup and return a typed message bus.
 * Consuming apps call this when the user clicks Add or Sync.
 *
 * The popup opens `/connect/stealth`, the Stealth Sync widget. It is a
 * different page from `/connect`, which is the older Link widget.
 *
 * Throws StealthKeyLeakError, before the popup is opened, if an app-mode init
 * carries key material.
 */
export function openStealthWidget(opts: {
  base_url?: string;     // default 'https://connect.orangerails.com'
  init: StealthInitMessage;
  on_message: (m: StealthMessageFromWidget) => void;
  on_close?: () => void;
  width?: number;        // default 480
  height?: number;       // default 720
}): { close: () => void; popup: Window | null } {
  // Refuse before anything is opened or posted. In app mode this returns an
  // init with no key field at all; in widget mode it returns the init as-is.
  const init = assertNoKeyInAppMode(opts.init);

  const base = (opts.base_url ?? 'https://connect.orangerails.com').replace(/\/$/, '');
  // `parent_origin` lets the widget target OR_STEALTH_READY at this exact
  // origin instead of broadcasting it with '*'. READY carries no secrets,
  // but the opener already knows its own origin, so there is no reason to
  // broadcast. See pickReadyTargetOrigin() in src/stealth/widget/App.tsx.
  const url =
    `${base}${STEALTH_WIDGET_PATH}` +
    `?mode=${encodeURIComponent(init.mode)}` +
    `&app=${encodeURIComponent(init.app_slug)}` +
    `&parent_origin=${encodeURIComponent(init.return_callback_origin)}`;
  const features = `width=${opts.width ?? 480},height=${opts.height ?? 720},menubar=no,toolbar=no,location=no,status=no`;
  const popup = window.open(url, 'or-stealth-widget', features);

  const handler = (e: MessageEvent) => {
    if (e.origin !== base) return;
    const msg = e.data as StealthMessageFromWidget;
    if (msg?.type === 'OR_STEALTH_READY') {
      popup?.postMessage(init, base);
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
