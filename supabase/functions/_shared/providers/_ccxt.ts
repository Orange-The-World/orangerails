/**
 * CCXT base — shared adapter scaffolding for the 100+ exchanges that
 * CCXT (https://github.com/ccxt/ccxt) wraps behind a unified interface.
 *
 * Strategy: instead of writing one adapter per exchange (n × person-hours),
 * we write ONE adapter that knows how to talk to any CCXT-supported
 * exchange. Each per-exchange entry in dispatch.ts becomes a thin
 * `makeCcxtAdapter({ slug, exchangeId, ... })` call.
 *
 * Adding the next exchange:
 *   1. Pick a CCXT exchange id (see https://github.com/ccxt/ccxt#exchanges)
 *   2. Add `makeCcxtAdapter({...})` call to dispatch.ts
 *   3. Done — discovery, sync, credential schema all auto-derived
 *
 * Per-exchange discovery is intentionally minimal: returns one synthetic
 * wallet entry per exchange. Trades + deposits + withdrawals across all
 * the user's assets get synced under that single wallet, which the
 * consumer (V2/V3/OW) can group by asset on the inbound side. This avoids
 * the O(N) discovery problem where N = number of asset balances the user
 * holds (CCXT's fetchBalance returns every asset including dust).
 *
 * Per-exchange credential schemas are auto-derived from CCXT's
 * `requiredCredentials` map. Coinbase wants apiKey + secret + password
 * (passphrase); Bybit wants apiKey + secret + uid; Kraken wants apiKey +
 * secret; etc. Adapter builds the form fields automatically.
 *
 * Sync pulls (when the exchange supports it — checked via `exchange.has`):
 *   - Trades       → type='trade'
 *   - Deposits     → type='deposit',    direction='in'
 *   - Withdrawals  → type='withdrawal', direction='out'
 *
 * NOT in v1 (deliberate scope cuts):
 *   - Per-asset wallet enumeration (today: one synthetic wallet per exchange)
 *   - Margin / futures positions (only spot trades for now)
 *   - Fee-as-separate-tx emission (today: fee is recorded in the trade
 *     but not split into its own NormalizedTransaction)
 *   - Per-symbol cursor tracking (today: single cursor across all symbols
 *     for trades — relies on CCXT's `since` param and consumer dedup)
 *
 * Cursor: highest tx timestamp (unix ms) seen across all three streams.
 * Persisted as a string of the millisecond integer.
 *
 * Bundle-size note: this module imports the full ccxt package via esm.sh.
 * Compressed payload is ~3 MB which fits comfortably under Supabase's
 * Edge Function bundle limit. If bundle size becomes a constraint as
 * more exchanges land, switch to per-exchange dynamic imports
 * (`await import('https://esm.sh/ccxt@4.4.30/js/src/<id>.js')`).
 */

// deno-lint-ignore-file no-explicit-any
import * as ccxt from 'https://esm.sh/ccxt@4.4.30';

import type {
  ProviderAdapter,
  DiscoveredWallet,
  NormalizedTransaction,
  SyncResult,
  CredentialField,
} from './types.ts';

// ─── Per-exchange config ─────────────────────────────────────────────────

export interface CcxtAdapterConfig {
  /** OR provider slug (the value stored in connections.provider_type). */
  slug: string;
  /** CCXT exchange id (binance, coinbase, kraken, etc.). */
  exchangeId: string;
  /** Display name in the picker. */
  displayName: string;
  /** Subtitle for the picker tile. */
  description?: string;
  /** Filter chips / search keywords. */
  tags?: string[];
  /** Sort weight inside category. */
  popularity?: number;
}

// ─── Credential field auto-derivation ────────────────────────────────────

/**
 * Build the CredentialField[] schema from CCXT's `requiredCredentials`
 * map. CCXT exposes which fields each exchange needs (apiKey, secret,
 * password, uid, walletAddress, privateKey, etc.) and which are optional.
 */
function buildCredentialFields(exchangeId: string): CredentialField[] {
  const ExchangeClass = (ccxt as any)[exchangeId];
  if (!ExchangeClass) {
    throw new Error(`[ccxt] unknown exchange id: ${exchangeId}`);
  }
  // requiredCredentials is a static-ish map on the prototype; reading
  // from a no-arg instance is the canonical way to access it without
  // calling any I/O methods.
  const required: Record<string, boolean> = new ExchangeClass({}).requiredCredentials ?? {};

  const fields: CredentialField[] = [];
  if (required.apiKey) {
    fields.push({
      name: 'apiKey',
      type: 'secret',
      label: 'API key',
      placeholder: 'From the exchange API settings',
    });
  }
  if (required.secret) {
    fields.push({
      name: 'secret',
      type: 'secret',
      label: 'API secret',
      placeholder: 'From the exchange API settings',
    });
  }
  if (required.password) {
    // Coinbase, KuCoin, OKX call this a "passphrase" in their UI.
    fields.push({
      name: 'password',
      type: 'secret',
      label: 'API passphrase',
      placeholder: 'The passphrase you set when creating the API key',
    });
  }
  if (required.uid) {
    fields.push({
      name: 'uid',
      type: 'string',
      label: 'User ID (UID)',
      placeholder: 'Your account UID',
    });
  }
  // walletAddress and privateKey are DEX-only and not in our v1 scope.
  return fields;
}

// ─── CCXT instance construction ──────────────────────────────────────────

function instantiateExchange(exchangeId: string, credentials: Record<string, unknown>): any {
  const ExchangeClass = (ccxt as any)[exchangeId];
  if (!ExchangeClass) {
    throw new Error(`[ccxt:${exchangeId}] unknown CCXT exchange id`);
  }
  // Pluck only the credential fields CCXT knows about — passing extras
  // doesn't break anything but keeps the call site explicit.
  const config: Record<string, unknown> = {
    enableRateLimit: true, // let CCXT throttle requests automatically
  };
  for (const field of ['apiKey', 'secret', 'password', 'uid', 'walletAddress', 'privateKey']) {
    if (typeof credentials[field] === 'string' && (credentials[field] as string).length > 0) {
      config[field] = credentials[field];
    }
  }
  return new ExchangeClass(config);
}

// ─── Discovery ───────────────────────────────────────────────────────────

/**
 * One synthetic wallet per exchange. The user picks the wallet in the OR
 * widget; per-asset enumeration happens during sync (CCXT methods
 * naturally span all assets the API key can see).
 *
 * We DO NOT call into CCXT here — exchange APIs almost universally block
 * browser-origin CORS, so the discovery flow can't actually validate the
 * API key from the widget anyway. The OR adapter validates on first
 * sync attempt instead.
 */
function buildDiscover(slug: string, _exchangeId: string) {
  return async function discoverWallets(
    _credentials: Record<string, unknown>,
  ): Promise<DiscoveredWallet[]> {
    return [
      {
        external_wallet_id: slug,
        currency: 'USD', // exchange wallets are multi-currency; this is the display default
        label: `${slug} account`,
      },
    ];
  };
}

// ─── Sync ────────────────────────────────────────────────────────────────

/**
 * Stream three CCXT data sources (trades, deposits, withdrawals) into one
 * combined NormalizedTransaction list. Each source contributes only what
 * the exchange's `has` map says it supports.
 *
 * `since` is unix ms — what CCXT expects as its `since` parameter.
 */
async function fetchAllSince(
  exchange: any,
  exchangeId: string,
  since: number | undefined,
): Promise<NormalizedTransaction[]> {
  const out: NormalizedTransaction[] = [];

  // ---- Trades ----------------------------------------------------------
  if (exchange.has?.fetchMyTrades) {
    try {
      // Pass undefined symbol to fetch all symbols at once. Most major
      // exchanges support this (Binance, Coinbase, Kraken, etc.). If a
      // specific exchange requires a symbol, CCXT throws NotSupported and
      // we skip — v1.1 will iterate over the user's balance assets to
      // build symbols when no-arg trades aren't supported.
      const trades = await exchange.fetchMyTrades(undefined, since, 500);
      for (const t of trades ?? []) {
        out.push(normalizeTrade(t, exchangeId));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/NotSupported/i.test(msg)) {
        // Not a "this feature isn't here" error — surface it.
        throw e;
      }
      console.warn(`[ccxt:${exchangeId}] fetchMyTrades unsupported without symbol; skipping`);
    }
  }

  // ---- Deposits --------------------------------------------------------
  if (exchange.has?.fetchDeposits) {
    try {
      const deposits = await exchange.fetchDeposits(undefined, since, 500);
      for (const d of deposits ?? []) {
        out.push(normalizeTransfer(d, 'deposit', 'in', exchangeId));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/NotSupported/i.test(msg)) throw e;
      console.warn(`[ccxt:${exchangeId}] fetchDeposits unsupported; skipping`);
    }
  }

  // ---- Withdrawals -----------------------------------------------------
  if (exchange.has?.fetchWithdrawals) {
    try {
      const withdrawals = await exchange.fetchWithdrawals(undefined, since, 500);
      for (const w of withdrawals ?? []) {
        out.push(normalizeTransfer(w, 'withdrawal', 'out', exchangeId));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/NotSupported/i.test(msg)) throw e;
      console.warn(`[ccxt:${exchangeId}] fetchWithdrawals unsupported; skipping`);
    }
  }

  return out;
}

/**
 * Normalize a CCXT Trade (https://docs.ccxt.com/#/?id=trade-structure).
 *
 * For accounting, a trade represents BOTH a buy of one asset AND a sell
 * of another (the symbol's base + quote). v1 emits a single
 * NormalizedTransaction with the cost (in quote currency) and lets V2's
 * SUSPENSE default rule route it for human review. v1.1 will emit two
 * legs (one per asset) when V2 has trade-routing rules in its yaml.
 */
function normalizeTrade(trade: any, exchangeId: string): NormalizedTransaction {
  const symbol = trade.symbol ?? '';
  const [base, quote] = symbol.split('/');
  const side = trade.side === 'sell' ? 'sell' : 'buy';
  const cost = Number(trade.cost ?? trade.price * trade.amount ?? 0);
  const direction: 'in' | 'out' = side === 'buy' ? 'out' : 'in';

  return {
    id: `trade-${trade.id ?? `${trade.timestamp}-${symbol}-${side}`}`,
    adapter: exchangeId,
    direction,
    type: 'trade',
    amount: cost > 0 ? cost : Number(trade.amount ?? 0),
    currency: (quote || base || 'USD').toUpperCase(),
    description: `${side.toUpperCase()} ${trade.amount ?? ''} ${base ?? ''} @ ${trade.price ?? ''} ${quote ?? ''}`.trim(),
    counterparty: null,
    status: 'CLOSED',
    timestamp: trade.datetime ?? new Date(trade.timestamp ?? Date.now()).toISOString(),
    source_wallet_id: exchangeId,
  };
}

/**
 * Normalize a CCXT Transaction (deposit or withdrawal).
 * https://docs.ccxt.com/#/?id=transaction-structure
 */
function normalizeTransfer(
  tx: any,
  type: 'deposit' | 'withdrawal',
  direction: 'in' | 'out',
  exchangeId: string,
): NormalizedTransaction {
  const currency = String(tx.currency ?? 'BTC').toUpperCase();
  const amount = Number(tx.amount ?? 0);
  const isBtc = currency === 'BTC';

  const base = {
    id: `${type}-${tx.id ?? tx.txid ?? `${tx.timestamp}-${currency}`}`,
    adapter: exchangeId,
    direction,
    type,
    description: tx.network ? `via ${tx.network}` : null,
    counterparty: typeof tx.address === 'string' ? tx.address : null,
    // CCXT statuses: 'ok' | 'pending' | 'failed' | 'canceled'. Map up:
    status:
      tx.status === 'ok' ? 'COMPLETE' : tx.status === 'pending' ? 'PENDING' : (tx.status ?? 'PENDING').toUpperCase(),
    timestamp: tx.datetime ?? new Date(tx.timestamp ?? Date.now()).toISOString(),
    source_wallet_id: exchangeId,
  } as const;

  if (isBtc) {
    return { ...base, amount_sats: Math.round(amount * 100_000_000) };
  }
  return { ...base, amount, currency };
}

// ─── Adapter factory ─────────────────────────────────────────────────────

export function makeCcxtAdapter(config: CcxtAdapterConfig): ProviderAdapter {
  const { slug, exchangeId, displayName, description, tags, popularity } = config;
  const credentialFields = buildCredentialFields(exchangeId);

  async function syncByWallets(
    credentials: Record<string, unknown>,
    walletIds: string[],
    cursor: string | null,
  ): Promise<SyncResult> {
    if (walletIds.length === 0) return { transactions: [], next_cursor: null };
    const exchange = instantiateExchange(exchangeId, credentials);
    const since = cursor ? Number(cursor) : undefined;

    const transactions = await fetchAllSince(exchange, exchangeId, since);

    // Cursor = highest timestamp (unix ms) seen across the batch.
    let maxSeen = since ?? 0;
    for (const tx of transactions) {
      const ts = new Date(tx.timestamp).getTime();
      if (ts > maxSeen) maxSeen = ts;
    }

    transactions.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

    return {
      transactions,
      next_cursor: maxSeen > 0 ? String(maxSeen) : null,
    };
  }

  async function syncAccountWide(
    credentials: Record<string, unknown>,
    cursor: string | null,
  ): Promise<SyncResult> {
    return syncByWallets(credentials, [slug], cursor);
  }

  return {
    slug,
    displayName,
    description,
    status: 'beta', // CCXT-backed adapters start as beta — many exchange APIs have edge cases
    category: 'exchange',
    tags,
    popularity,
    multiWallet: false, // single synthetic wallet per exchange in v1
    credentialFields,
    discoverWallets: buildDiscover(slug, exchangeId),
    syncByWallets,
    syncAccountWide,
  };
}
