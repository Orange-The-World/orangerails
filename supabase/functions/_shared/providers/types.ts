/**
 * Source-adapter framework — per-provider TypeScript modules registered against
 * a slug. or-connection-create / or-discover-wallets / or-sync look up the
 * adapter for a connection's `provider_type` and delegate to it.
 *
 * Pattern mirrors `_shared/sinks/` — the reason sinks needed a registry was
 * "consumer apps will multiply"; the same is true for providers (xpub today,
 * Strike + BTCPay next, then 100 CCXT exchanges, plus Quiltt / SimpleFIN
 * aggregators that bring whole ecosystems behind a single adapter — see
 * OrangeRails-Protocol.html §18).
 *
 * Each adapter:
 *   - Declares its `slug` (matches `connections.provider_type` column)
 *   - Declares the shape of the credential blob it expects to find inside
 *     the encrypted_credentials ciphertext (informational; UI uses this to
 *     render the right form fields)
 *   - Implements `discoverWallets` — pure pass-through, no DB writes; the
 *     caller decides what to keep via or-source-wallets-set
 *   - Implements `syncByWallets` (preferred) and `syncAccountWide` (legacy
 *     fallback for connections that pre-date wallet selection)
 *
 * Adapters MUST be self-contained. No DB calls, no platform-auth concerns.
 * The edge functions handle auth + persistence; the adapter just speaks
 * upstream and translates to canonical.
 */

// ─── Canonical shapes ────────────────────────────────────────────────────

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
  /** Provider slug — matches the adapter's `slug`. */
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
   * Opaque provider-side wallet identifier. Stored plaintext in
   * `source_wallets.external_wallet_id` and passed back to the adapter on
   * subsequent sync calls.
   */
  external_wallet_id: string;
  /** ISO 4217 code or 'BTC'. */
  currency: string;
  /** Optional human-readable label. UI may use this in the wallet picker. */
  label?: string;
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

// ─── Adapter contract ────────────────────────────────────────────────────

/**
 * Hint about the credential shape an adapter expects. Informational —
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
}

export interface ProviderAdapter {
  /** Slug stored in `connections.provider_type`. */
  slug: string;

  /** Human label for this provider. UI catalog uses it. */
  displayName: string;

  /** Schema for the credential blob the adapter expects. */
  credentialFields: CredentialField[];

  /**
   * Whether discovery is meaningful for this provider. Some providers
   * (Blink, Strike, exchanges) have multiple wallets per account — the user
   * picks which to sync. Others (xpub, single-wallet BTCPay store) yield
   * exactly one wallet — UIs MAY skip the picker step.
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
   * wallets first then calls syncByWallets — but a raw account-wide pull
   * is allowed (Blink's path) when the upstream API supports it natively.
   *
   * Returned transactions have `source_wallet_id: null` since the wallet
   * binding is unknown to the legacy path. Downstream consumers must
   * treat null as "wallet membership unknown — pre-discovery connection."
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
