/**
 * Strike source adapter — https://strike.me Lightning + multi-currency wallet.
 *
 * Strike's Greenfield-style API lives at https://api.strike.me/v1 and
 * authenticates with a Bearer token (API key generated from the Strike
 * Dashboard at https://dashboard.strike.me/developer/api-keys).
 *
 * One Strike account = one OR source_wallet. There's no multi-wallet
 * concept on the upstream side (Strike accounts hold balances in BTC +
 * USD + EUR + USDT + GBP + AUD under a single account identity), so we
 * surface a single synthetic wallet entry that the user accepts in the
 * picker.
 *
 * What we emit per sync:
 *   PAID invoices       → direction='in', type='lightning'
 *                         (V2 yaml routes lightning IN to Sales credit —
 *                         right for merchant invoice income)
 *   PENDING invoices    → same, status=PENDING (surfaces as in-flight)
 *   UNPAID invoices     → skipped (no value moved yet)
 *   CANCELLED invoices  → skipped (no money moved)
 *
 * NOT in v1 (deliberate scope cuts):
 *   - Payouts (`/v1/payouts`) — outgoing withdrawals to bank / external wallet
 *   - Deposits (`/v1/deposits`) — funding Strike from a bank
 *   - Currency exchanges (`/v1/currency-exchange-quotes`) — internal swaps
 *   - Per-invoice settlement detail (the `transactions[]` array on each
 *     invoice carries amountReceived in the actual settlement currency;
 *     v1 emits the invoice's nominal amount instead)
 *
 * Cursor: highest `created` timestamp (ISO 8601) seen across the batch.
 * Next sync passes it as `created ge '<iso>'` in the OData $filter so
 * Strike filters server-side.
 *
 * Pagination: OData $skip + $top (page size 100). Loop until a partial
 * page returns. Capped at MAX_PAGES_PER_SYNC for safety.
 *
 * Test environment: Strike does not advertise a public sandbox. Adapter
 * runs against production; merchants generate a read-only API key with
 * the `partner.account.profile.read` and `partner.invoice.read` scopes
 * before connecting.
 */

import type {
  ProviderAdapter,
  DiscoveredWallet,
  NormalizedTransaction,
  SyncResult,
} from './types.ts';

const STRIKE_API = 'https://api.strike.me/v1';
const PAGE_SIZE = 100;
const MAX_PAGES_PER_SYNC = 50;
const SOURCE_WALLET_ID = 'strike';

// ─── Types ───────────────────────────────────────────────────────────────

interface StrikeCredentials {
  api_key: string;
}

type StrikeInvoiceState = 'UNPAID' | 'PENDING' | 'PAID' | 'CANCELLED';

interface StrikeAmount {
  /** Decimal string, e.g. "10.00". */
  amount: string;
  /** ISO 4217 code or 'BTC' / 'USDT' / etc. */
  currency: string;
}

interface StrikeInvoice {
  invoiceId: string;
  amount: StrikeAmount;
  state: StrikeInvoiceState;
  /** ISO 8601 timestamp issued. */
  created: string;
  /** ISO 8601 timestamp paid (only when state=PAID). */
  completed?: string;
  /** Merchant's external order ID (max 40 chars). */
  correlationId?: string;
  /** Free-text description (max 200 chars). */
  description?: string;
  issuerId?: string;
  receiverId?: string;
  payerId?: string;
}

// Strike OData responses don't follow a strict envelope shape across
// every endpoint, but /v1/invoices wraps results in `items` with
// `count` + `links` siblings. We only care about `items`.
interface InvoicesPage {
  items?: StrikeInvoice[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function parseStrikeCredentials(c: Record<string, unknown>): StrikeCredentials {
  const api_key = c.api_key;
  if (typeof api_key !== 'string' || !api_key.trim()) {
    throw new Error('[strike] credentials.api_key required');
  }
  return { api_key: api_key.trim() };
}

async function strikeGet<T>(creds: StrikeCredentials, path: string): Promise<T> {
  const res = await fetch(`${STRIKE_API}${path}`, {
    headers: {
      Authorization: `Bearer ${creds.api_key}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Strike ${res.status} ${path}: ${detail.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ─── Adapter implementation ──────────────────────────────────────────────

async function discover(_credentials: Record<string, unknown>): Promise<DiscoveredWallet[]> {
  parseStrikeCredentials(_credentials); // validate up front so a bad key fails at discover
  // One Strike account = one logical wallet. Currency 'USD' is the
  // adapter-default since most Strike merchants price in USD; per-tx
  // currency is captured on the emitted NormalizedTransaction.
  return [
    {
      external_wallet_id: SOURCE_WALLET_ID,
      currency: 'USD',
      label: 'Strike account',
    },
  ];
}

/**
 * Build the OData $filter clause: state in (PAID, PENDING) AND created
 * past the cursor. Strike supports `state eq 'X' or state eq 'Y'` for
 * disjunctions and `created ge datetime'<iso>'` for date floors.
 */
function buildFilter(sinceIso: string | null): string {
  const stateClause = "(state eq 'PAID' or state eq 'PENDING')";
  if (!sinceIso) return stateClause;
  // Single-quote escaping not needed for ISO 8601 strings; Strike accepts
  // the literal in single quotes.
  return `${stateClause} and created ge '${sinceIso}'`;
}

async function fetchInvoicesSince(
  creds: StrikeCredentials,
  sinceIso: string | null,
): Promise<StrikeInvoice[]> {
  const out: StrikeInvoice[] = [];
  let skip = 0;

  for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
    const params = new URLSearchParams();
    params.set('$filter', buildFilter(sinceIso));
    params.set('$orderby', 'created asc');
    params.set('$top', String(PAGE_SIZE));
    params.set('$skip', String(skip));

    const data = await strikeGet<InvoicesPage>(creds, `/invoices?${params.toString()}`);
    const items = data.items ?? [];
    out.push(...items);
    if (items.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }
  return out;
}

function normalizeInvoice(invoice: StrikeInvoice): NormalizedTransaction | null {
  const amount = Number(invoice.amount?.amount);
  if (!isFinite(amount) || amount <= 0) return null;

  const currency = (invoice.amount?.currency || 'USD').toUpperCase();
  const isBtc = currency === 'BTC';

  // Strike invoices don't expose the payer's identity (Lightning =
  // pseudonymous; the payerId, when set, is the Strike-side dedicated
  // payer's UUID, not a useful counterparty). Use the description /
  // correlationId for memo + leave counterparty null.
  const description =
    (typeof invoice.description === 'string' && invoice.description) ||
    (typeof invoice.correlationId === 'string' ? `Order ${invoice.correlationId}` : null);

  // Use the completed timestamp when available (when actual money moved)
  // and fall back to created for PENDING invoices that haven't settled.
  const ts = invoice.completed || invoice.created;

  const base = {
    id: invoice.invoiceId,
    adapter: 'strike',
    direction: 'in' as const,
    // Lightning is the right route for merchant invoice income (V2 yaml
    // sends lightning IN to Sales/revenue). Strike invoices can be paid
    // via Lightning OR on-chain, but the merchant's accounting intent is
    // the same either way.
    type: 'lightning' as const,
    description,
    counterparty: null,
    status: invoice.state,
    timestamp: new Date(ts).toISOString(),
    source_wallet_id: SOURCE_WALLET_ID,
  };

  if (isBtc) {
    // Strike returns BTC in BTC units (decimal), not sats. Convert.
    return { ...base, amount_sats: Math.round(amount * 100_000_000) };
  }
  return { ...base, amount, currency };
}

async function syncByWallets(
  credentials: Record<string, unknown>,
  walletIds: string[],
  cursor: string | null,
): Promise<SyncResult> {
  if (walletIds.length === 0) return { transactions: [], next_cursor: null };
  const creds = parseStrikeCredentials(credentials);

  // Cursor = highest 'created' ISO timestamp seen on previous sync.
  const invoices = await fetchInvoicesSince(creds, cursor);

  const transactions: NormalizedTransaction[] = [];
  let maxSeen = cursor ?? '';
  for (const inv of invoices) {
    const norm = normalizeInvoice(inv);
    if (norm) transactions.push(norm);
    if (inv.created > maxSeen) maxSeen = inv.created;
  }

  // Sort newest first to keep persisted order roughly consistent.
  transactions.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

  return {
    transactions,
    next_cursor: maxSeen || null,
  };
}

async function syncAccountWide(
  credentials: Record<string, unknown>,
  cursor: string | null,
): Promise<SyncResult> {
  // Strike has only one wallet per account, so account-wide and
  // wallet-scoped paths produce identical output. Reuse the byWallets
  // path with a synthetic wallet id.
  return syncByWallets(credentials, [SOURCE_WALLET_ID], cursor);
}

export const strikeAdapter: ProviderAdapter = {
  slug: 'strike',
  displayName: 'Strike',
  description: 'Lightning + USD',
  multiWallet: false,
  credentialFields: [
    {
      name: 'api_key',
      type: 'secret',
      label: 'Strike API key',
      placeholder: 'Generate at dashboard.strike.me/developer/api-keys',
    },
  ],
  discoverWallets: discover,
  syncByWallets,
  syncAccountWide,
};
