/**
 * Source-adapter framework , per-provider TypeScript modules registered against
 * a slug. or-connection-create / or-discover-wallets / or-sync look up the
 * adapter for a connection's `provider_type` and delegate to it.
 *
 * Pattern mirrors `_shared/sinks/` , the reason sinks needed a registry was
 * "consumer apps will multiply"; the same is true for providers (xpub today,
 * Strike + BTCPay next, then 100 CCXT exchanges, plus Quiltt / SimpleFIN
 * aggregators that bring whole ecosystems behind a single adapter , see
 * OrangeRails-Protocol.html §18).
 *
 * Each adapter:
 *   - Declares its `slug` (matches `connections.provider_type` column)
 *   - Declares the shape of the credential blob it expects to find inside
 *     the encrypted_credentials ciphertext (informational; UI uses this to
 *     render the right form fields)
 *   - Implements `discoverWallets` , pure pass-through, no DB writes; the
 *     caller decides what to keep via or-source-wallets-set
 *   - Implements `syncByWallets` (preferred) and `syncAccountWide` (legacy
 *     fallback for connections that pre-date wallet selection)
 *
 * Adapters MUST be self-contained. No DB calls, no platform-auth concerns.
 * The edge functions handle auth + persistence; the adapter just speaks
 * upstream and translates to canonical.
 */

// --- Canonical shapes ---------------------------------------------------

/**
 * Internal canonical shape produced by source adapters.
 *
 * MIGRATION NOTE: this is OR's de-facto v0 canonical model, intentionally
 * shared with `_shared/sinks/types.ts` (re-exported below). The protocol
 * doc's CanonicalTransaction (with `amount: { value: string; unit: string }`,
 * `fees[]`, `fiat_equivalent`, `trade` extension, `cost_basis`, etc.) is the
 * forward target. We migrate by extending NormalizedTransaction over time
 * while keeping the field names sink adapters depend on stable.
 */
export interface NormalizedTransaction {
  /** Provider-side stable id, used as `external_id` for dedup. */
  id: string;
  /** Provider slug , matches the adapter's `slug`. */
  adapter: string;
  /** Direction relative to the connected account. */
  direction: 'in' | 'out';
  /** Transaction kind. Will expand as more sources land. */
  type: 'lightning' | 'onchain' | 'trade' | 'deposit' | 'withdrawal' | 'fee';
  /** BTC amount in satoshis when the source is denominated in BTC. */
  amount_sats?: number;
  /** Non-BTC amount when the source returns USD/EUR/etc. */
  amount?: number;
  /** ISO 4217 code or BTC unit when amount is set. */
  currency?: string;
  /** Free-text memo from the provider. */
  description?: string | null;
  /** Counterparty handle or address (Lightning username, on-chain address, etc.). */
  counterparty?: string | null;
  /** Provider-reported status string (each adapter maps its own). */
  status?: string;
  /** ISO 8601 timestamp the value moved at the provider. */
  timestamp: string;
  /**
   * The connection-level wallet this transaction came from. Set when sync
   * was scoped via source_wallets; null for legacy account-wide sync.
   */
  source_wallet_id: string | null;
}

export interface DiscoveredWallet {
  /**
   * Opaque, cryptographically random wallet identifier (UUID v4). This is
   * what is stored in `source_wallets.external_wallet_id` and passed back to
   * the adapter on subsequent sync calls as `source_wallet_id`.
   *
   * This value MUST have zero derivable relationship to the underlying key
   * material. An external observer holding the raw credential (e.g. an xpub)
   * must learn nothing from seeing this value.
   */
  external_wallet_id: string;
  /** ISO 4217 code or 'BTC'. */
  currency: string;
  /** Optional human-readable label. UI may use this in the wallet picker. */
  label?: string;
  /**
   * Internal HMAC-SHA256 fingerprint of the underlying key material.
   * Used by the persistence layer (or-source-wallets-set) for deduplication
   * on reconnect: if a fingerprint already exists in source_wallets, the
   * existing external_wallet_id is reused instead of inserting a new row.
   *
   * MUST NOT appear in any external API response body, edge-function log
   * line, or error message. Only external_wallet_id is emitted to callers.
   * Adapters that do not support keyed fingerprinting may omit this field.
   */
  wallet_fingerprint?: string;
  /**
   * The provider's real, stable per-account key for this wallet (e.g. a Strike
   * receiverId). Account-identifying, so it is INTERNAL server-side only: like
   * wallet_fingerprint it MUST NOT appear in any external API response body,
   * log line, or error message.
   *
   * or-discover-wallets records it in the discovery_sessions table (keyed by
   * the widget session and external_wallet_id) and strips it from the client
   * response. The write path (or-link-complete) reads it back from that table
   * to compute the internal dedup fingerprint, so the key never reaches the
   * browser or integrator. Adapters whose account key is not available at
   * discovery time may omit this field (dedup then falls back to no fingerprint).
   */
  account_key?: string;
}

export interface SyncResult {
  transactions: NormalizedTransaction[];
  /**
   * Opaque cursor for the next sync. The adapter defines its meaning
   * (a Blink GraphQL endCursor, an xpub max-block-height, an exchange
   * trade-id, etc.). OR persists it in `connections.last_sync_cursor`
   * and hands it back unchanged on the next call.
   */
  next_cursor: string | null;
}

// --- Adapter contract ---------------------------------------------------

/**
 * Hint about the credential shape an adapter expects. Informational ,
 * platforms (V2, V3, OW) read this to render the right form fields, then
 * ship the encrypted JSON to or-connection-create. The adapter itself
 * receives the decrypted JSON via the `credentials` argument.
 */
export interface CredentialField {
  /** JSON key name inside the encrypted credentials object. */
  name: string;
  /** Type hint for UI rendering. */
  type: 'string' | 'secret';
  /** Human label for the form field. */
  label: string;
  /** Optional placeholder / example. */
  placeholder?: string;
  /** When false, the platform UI must collect this. Defaults to true. */
  optional?: boolean;
  /**
   * Render as a multi-line textarea. Useful for long values (xpubs, PEM
   * certificates, verbose JSON pastes). Defaults to single-line input.
   */
  multiline?: boolean;
  /**
   * Optional inline help shown below the field. When `helpHref` is set
   * the widget renders the label as a link; otherwise plain text.
   */
  helpLabel?: string;
  helpHref?: string;
}

export interface ProviderAdapter {
  /** Slug stored in `connections.provider_type`. */
  slug: string;

  /** Human label for this provider. UI catalog uses it. */
  displayName: string;

  /**
   * Subtitle line for the picker tile. Short , "Lightning + on-chain",
   * "On-chain watch-only", etc. Optional; the slug is used if missing.
   */
  description?: string;

  /**
   * Lifecycle status surfaced in the UI catalog. `coming_soon` lets a
   * platform render a greyed-out tile for an entry without an adapter
   * (placeholder manifests in dispatch.ts). Defaults to `live`.
   */
  status?: 'live' | 'beta' | 'coming_soon';

  /**
   * High-level grouping for the picker UI. Lets consumers (V2, V3, OW)
   * render category tiles + a searchable filtered list within each
   * category instead of one flat tile-per-provider grid (which doesn't
   * scale past ~10 providers, let alone the 100+ via CCXT).
   *
   * Categories:
   *   - 'lightning_wallet'   custodial Lightning wallets (Blink, Strike)
   *   - 'on_chain_wallet'    watch-only on-chain (xpub) and future native wallets
   *   - 'payment_processor'  merchant Bitcoin payment processors (BTCPay, future Flash)
   *   - 'exchange'           crypto exchanges (CCXT-backed: Coinbase, Kraken, Binance, etc.)
   *   - 'card'               Bitcoin debit cards (future)
   *   - 'mining'             mining pools (future Braiins, Ocean)
   *   - 'bank'               traditional banking aggregators (future Quiltt, SimpleFIN)
   *   - 'lender'             Bitcoin-backed lenders (future Unchained, Ledn)
   */
  category?:
    | 'lightning_wallet'
    | 'on_chain_wallet'
    | 'payment_processor'
    | 'exchange'
    | 'card'
    | 'mining'
    | 'bank'
    | 'lender';

  /**
   * Free-form tags the picker can use for filter chips ("Canada",
   * "Lightning", "Self-hosted") and full-text search matching. Lower-case,
   * hyphenated. Country codes are ISO 3166-1 alpha-2 lower-case ('us',
   * 'ca', 'eu').
   */
  tags?: string[];

  /**
   * Default sort weight inside a category , higher first. Hand-picked so
   * the most popular options surface first. Defaults to 50.
   */
  popularity?: number;

  /** Schema for the credential blob the adapter expects. */
  credentialFields: CredentialField[];

  /**
   * Whether discovery is meaningful for this provider. Some providers
   * (Blink, Strike, exchanges) have multiple wallets per account , the user
   * picks which to sync. Others (xpub, single-wallet BTCPay store) yield
   * exactly one wallet , UIs MAY skip the picker step.
   */
  multiWallet: boolean;

  /**
   * Pure pass-through wallet enumeration. Decrypted credentials are passed
   * in; the adapter calls upstream and returns what it finds. The caller
   * decides what to persist via or-source-wallets-set.
   */
  discoverWallets: (credentials: Record<string, unknown>) => Promise<DiscoveredWallet[]>;

  /**
   * Sync transactions for the user's selected wallets. Each returned
   * transaction MUST set `source_wallet_id` to the matching
   * `external_wallet_id` so consumers can route per-wallet.
   *
   * `cursor` is the opaque value the adapter returned on the previous
   * sync (or null on first sync). The adapter defines what it means.
   */
  syncByWallets: (
    credentials: Record<string, unknown>,
    walletIds: string[],
    cursor: string | null,
  ) => Promise<SyncResult>;

  /**
   * Sync without a wallet filter. Used for legacy connections that exist
   * in the DB without `source_wallets` rows (pre-discovery feature). Most
   * new providers can implement this as a thin wrapper that discovers
   * wallets first then calls syncByWallets , but a raw account-wide pull
   * is allowed (Blink's path) when the upstream API supports it natively.
   *
   * Returned transactions have `source_wallet_id: null` since the wallet
   * binding is unknown to the legacy path. Downstream consumers must
   * treat null as "wallet membership unknown , pre-discovery connection."
   */
  syncAccountWide: (
    credentials: Record<string, unknown>,
    cursor: string | null,
  ) => Promise<SyncResult>;
}

/**
 * Helper: parse the decrypted credentials JSON and validate required fields
 * against the adapter's declared schema. Throws a helpful error rather than
 * letting an undefined field surface as a confusing upstream call failure.
 */
export function parseCredentials(
  adapter: ProviderAdapter,
  credentialsJson: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(credentialsJson);
  } catch (err) {
    throw new Error(`[${adapter.slug}] credentials JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`[${adapter.slug}] credentials must be an object`);
  }
  const obj = parsed as Record<string, unknown>;
  for (const field of adapter.credentialFields) {
    if (field.optional) continue;
    const v = obj[field.name];
    if (v === undefined || v === null || v === '') {
      throw new Error(`[${adapter.slug}] credentials.${field.name} required`);
    }
  }
  return obj;
}
