/**
 * BTCPay Server source adapter , self-hosted Bitcoin payment processor.
 *
 * BTCPay merchants run their own server (or a shared community instance).
 * Each server exposes the Greenfield API at `${btcpay_url}/api/v1`,
 * authenticated with `Authorization: token <api_key>` (custom format,
 * NOT Bearer , verified against
 * https://docs.btcpayserver.org/Development/GreenFieldExample/).
 *
 * Test instance: https://mainnet.demo.btcpayserver.org. Sign in, go to
 * Account → Manage Account → API Keys, generate a key with at minimum
 * `btcpay.store.canviewinvoices` and `btcpay.store.canviewstoresettings`.
 *
 * Modeling: each BTCPay store = one OR source_wallet. The discovered
 * wallet's currency comes from the store's `defaultCurrency` (often USD/EUR
 * for merchants, sometimes BTC for sat-stackers). The per-invoice currency
 * may differ , that's captured on the emitted NormalizedTransaction.
 *
 * What we emit per sync:
 *   Settled invoices   → direction='in', type='lightning'
 *                        (V2 yaml routes lightning IN → Sales credit, which
 *                        matches what merchants want for invoice receipts;
 *                        the alternative onchain rule routes credit to
 *                        Bitcoin Clearing which is wrong for merchant sales)
 *   Processing invoices → direction='in', type='lightning', status=Processing
 *                        (V2 yaml maps Processing → PENDING , surfaces in
 *                        review UI as "in flight")
 *   New / Expired / Invalid → skipped (no value moved)
 *
 * NOT in v1 (deliberate scope cuts, easy follow-ups):
 *   - Payouts (`/api/v1/stores/{id}/payouts`) , outgoing merchant payouts
 *   - Lightning vs on-chain detection (needs `?includePaymentMethods=true`
 *     and an extra parse of the `paymentMethodIds` array). All invoices
 *     default to `type='lightning'` for now.
 *   - BTC settlement amounts when invoice is priced in fiat (would need
 *     payment-methods data; merchant accounting cares about the fiat
 *     amount sold, which is what we emit today)
 *
 * Cursor: highest invoice `createdTime` (unix seconds) seen across all
 * stores in this sync. Next sync passes it as `startDate` so BTCPay
 * server-side filters to invoices >= that timestamp.
 */

import type {
  ProviderAdapter,
  DiscoveredWallet,
  NormalizedTransaction,
  SyncResult,
} from '../types.ts';

const PAGE_SIZE = 100;
const MAX_PAGES_PER_STORE = 50; // safety cap , 5,000 invoices per store per sync

// ─── Types ───────────────────────────────────────────────────────────────

interface BtcPayCredentials {
  /** Base URL of the merchant's BTCPay instance, e.g. https://mainnet.demo.btcpayserver.org. */
  btcpay_url: string;
  /** Greenfield API key with btcpay.store.canviewinvoices permission. */
  api_key: string;
}

interface BtcPayStore {
  id: string;
  name: string;
  /** Store's default fiat currency, e.g. 'USD', 'EUR', 'BTC'. */
  defaultCurrency: string;
}

interface BtcPayInvoice {
  id: string;
  storeId: string;
  /** Decimal string in the invoice's currency (e.g. "10.00"). */
  amount: string;
  /** ISO 4217 code or 'BTC'. */
  currency: string;
  type: 'Standard' | 'TopUp';
  status: 'New' | 'Processing' | 'Expired' | 'Invalid' | 'Settled';
  additionalStatus?: string;
  /** Unix seconds. */
  createdTime: number;
  expirationTime: number;
  monitoringExpiration: number;
  metadata?: Record<string, unknown> & {
    orderId?: string;
    itemDesc?: string;
    buyerEmail?: string;
    posData?: unknown;
  };
  checkoutLink?: string;
}

// ─── HTTP helpers ────────────────────────────────────────────────────────

function parseBtcPayCredentials(c: Record<string, unknown>): BtcPayCredentials {
  const btcpay_url = c.btcpay_url;
  const api_key = c.api_key;
  if (typeof btcpay_url !== 'string' || !/^https?:\/\//.test(btcpay_url)) {
    throw new Error('[btcpay] credentials.btcpay_url required (https://your-btcpay.example.com)');
  }
  if (typeof api_key !== 'string' || !api_key) {
    throw new Error('[btcpay] credentials.api_key required');
  }
  return {
    btcpay_url: btcpay_url.replace(/\/+$/, ''), // strip trailing slashes
    api_key,
  };
}

async function btcpayGet<T>(creds: BtcPayCredentials, path: string): Promise<T> {
  // Identify as a real client to bypass any Cloudflare / WAF bot heuristics
  // on self-hosted BTCPay instances. Same fix shape as Strike / Blink , see
  // diagnosis 2026-05-22 (Strike's CF was rejecting Deno's default fetch UA).
  const res = await fetch(`${creds.btcpay_url}${path}`, {
    headers: {
      'Authorization': `token ${creds.api_key}`,
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'OrangeRails/1.0 (+https://orangerails.com; sync-agent)',
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`BTCPay ${res.status} ${path}: ${detail.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ─── Adapter implementation ──────────────────────────────────────────────

async function discover(credentials: Record<string, unknown>): Promise<DiscoveredWallet[]> {
  const creds = parseBtcPayCredentials(credentials);
  const stores = await btcpayGet<BtcPayStore[]>(creds, '/api/v1/stores');
  if (!Array.isArray(stores)) {
    throw new Error('[btcpay] /api/v1/stores returned non-array');
  }
  return stores.map(s => ({
    external_wallet_id: s.id,
    // Default currency on the store is the *invoice* default , could be USD,
    // EUR, BTC, etc. We surface it as the wallet currency so the consumer's
    // wallet ledger picks the right account currency on first sight.
    currency: s.defaultCurrency || 'BTC',
    label: s.name,
  }));
}

/**
 * Fetch invoices for one store, paginating until exhausted (or safety cap hit).
 * Server-side filters: status (Settled + Processing) and startDate (cursor).
 *
 * BTCPay supports passing `status` multiple times for OR-semantics , done here
 * via repeated query params. Settled means "paid in full and cleared";
 * Processing means "paid but waiting for confirmations".
 */
async function fetchStoreInvoicesSince(
  creds: BtcPayCredentials,
  storeId: string,
  startDate: number | null,
): Promise<BtcPayInvoice[]> {
  const out: BtcPayInvoice[] = [];
  let skip = 0;

  for (let page = 0; page < MAX_PAGES_PER_STORE; page++) {
    const params = new URLSearchParams();
    params.set('take', String(PAGE_SIZE));
    params.set('skip', String(skip));
    params.append('status', 'Settled');
    params.append('status', 'Processing');
    if (startDate != null) params.set('startDate', String(startDate));

    const batch = await btcpayGet<BtcPayInvoice[]>(
      creds,
      `/api/v1/stores/${encodeURIComponent(storeId)}/invoices?${params.toString()}`,
    );
    if (!Array.isArray(batch)) {
      throw new Error(`[btcpay] /invoices returned non-array for store ${storeId}`);
    }
    out.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }
  return out;
}

function normalizeInvoice(invoice: BtcPayInvoice, storeId: string): NormalizedTransaction | null {
  const amount = Number(invoice.amount);
  if (!isFinite(amount) || amount <= 0) return null;

  const currency = (invoice.currency || '').toUpperCase();
  const isBtc = currency === 'BTC' || currency === 'SATS';

  // For invoice metadata, prefer human-readable description; fall back to
  // orderId; counterparty from buyerEmail if BTCPay's checkout collected it.
  const description =
    typeof invoice.metadata?.itemDesc === 'string'
      ? invoice.metadata.itemDesc
      : typeof invoice.metadata?.orderId === 'string'
        ? `Order ${invoice.metadata.orderId}`
        : null;
  const counterparty =
    typeof invoice.metadata?.buyerEmail === 'string' ? invoice.metadata.buyerEmail : null;

  const base = {
    id: invoice.id,
    adapter: 'btcpay',
    direction: 'in' as const,
    // Lightning is the right route for merchant invoice income , V2 yaml
    // sends lightning IN to Sales (revenue). On-chain IN goes to Bitcoin
    // Clearing which is wrong for merchant sales. v1.1 will detect actual
    // settlement method per invoice via includePaymentMethods=true.
    type: 'lightning' as const,
    description,
    counterparty,
    status: invoice.status,
    timestamp: new Date(invoice.createdTime * 1000).toISOString(),
    source_wallet_id: storeId,
  };

  if (isBtc) {
    // BTCPay returns BTC invoices in BTC units, not sats. Convert.
    const sats = currency === 'SATS' ? Math.round(amount) : Math.round(amount * 100_000_000);
    return { ...base, amount_sats: sats };
  }
  return { ...base, amount, currency };
}

async function syncByWallets(
  credentials: Record<string, unknown>,
  walletIds: string[],
  cursor: string | null,
): Promise<SyncResult> {
  if (walletIds.length === 0) return { transactions: [], next_cursor: null };
  const creds = parseBtcPayCredentials(credentials);

  // Cursor = highest createdTime (unix seconds) seen on previous sync. Pass
  // as startDate so BTCPay filters server-side. null on first sync.
  const startDate = cursor ? Number(cursor) : null;

  const allTxs: NormalizedTransaction[] = [];
  let maxSeen = startDate ?? 0;

  for (const storeId of walletIds) {
    const invoices = await fetchStoreInvoicesSince(creds, storeId, startDate);
    for (const inv of invoices) {
      const norm = normalizeInvoice(inv, storeId);
      if (norm) allTxs.push(norm);
      if (inv.createdTime > maxSeen) maxSeen = inv.createdTime;
    }
  }

  // Sort newest first to keep persisted order roughly consistent across the
  // multi-store flatten. Consumer's (connection_id, external_id) UNIQUE
  // constraint dedups.
  allTxs.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

  return {
    transactions: allTxs,
    next_cursor: maxSeen > 0 ? String(maxSeen) : null,
  };
}

async function syncAccountWide(
  credentials: Record<string, unknown>,
  cursor: string | null,
): Promise<SyncResult> {
  // Legacy path , connection has no source_wallets selection. Discover and
  // pull from every store the API key can see.
  const wallets = await discover(credentials);
  return syncByWallets(credentials, wallets.map(w => w.external_wallet_id), cursor);
}

export const btcpayAdapter: ProviderAdapter = {
  slug: 'btcpay',
  displayName: 'BTCPay Server',
  description: 'Self-hosted merchant',
  category: 'payment_processor',
  tags: ['merchant', 'self-hosted', 'lightning', 'on-chain'],
  custody: 'self_custody',
  popularity: 85,
  multiWallet: true,
  credentialFields: [
    {
      name: 'btcpay_url',
      type: 'string',
      label: 'BTCPay Server URL',
      placeholder: 'https://your-btcpay.example.com',
    },
    {
      name: 'api_key',
      type: 'secret',
      label: 'API key',
      placeholder: 'Account → Manage Account → API Keys',
    },
  ],
  discoverWallets: discover,
  syncByWallets,
  syncAccountWide,
};
