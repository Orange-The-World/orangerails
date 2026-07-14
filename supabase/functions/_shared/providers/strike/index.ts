/**
 * Strike source adapter, https://strike.me Lightning + multi-currency wallet.
 *
 * Strike's Greenfield-style API lives at https://api.strike.me/v1 and
 * authenticates with a Bearer token (API key generated from the Strike
 * Dashboard at https://dashboard.strike.me, API Key section).
 *
 * One Strike account = one OR source_wallet. There's no multi-wallet
 * concept on the upstream side (Strike accounts hold balances in BTC +
 * USD + EUR + USDT + GBP + AUD under a single account identity), so we
 * surface a single synthetic wallet entry that the user accepts in the
 * picker.
 *
 * Account identity: external_wallet_id is Strike's own stable per-account
 * UUID, read from the issuerId field on the newest invoice (or receiverId on
 * the newest receive) during discovery. These ids are assigned at account
 * creation and are immutable. If no transaction exists yet we refuse to
 * connect rather than storing a placeholder; the user must make at least one
 * transaction in Strike before connecting.
 *
 * Architecture: webhook-driven, never OData list scans
 *
 * Strike's api.strike.me sits behind Cloudflare's Bot Management. Empirical
 * testing on 2026-05-25 from multiple egress points (Supabase Edge AWS,
 * OVH Quebec, residential) with three header configurations (bare, Marfusios's
 * .NET SDK pattern, current OR) proved that Cloudflare challenges requests
 * by URL SHAPE, not TLS fingerprint or User-Agent:
 *
 *   GET /v1/balances                            200 OK, JSON          OK
 *   GET /v1/invoices?$top=1&$orderby=created    200 OK, JSON          OK
 *   GET /v1/invoices/{id}                       200 / 404, JSON       OK
 *   GET /v1/invoices?$filter=(a or b)&$top=...  403, CF HTML          BLOCKED
 *
 * Cloudflare's WAF flags compound `or` inside an OData $filter clause.
 * Simple $top, $skip, $orderby, and single-term $filter pass cleanly.
 *
 * Every other production Strike caller (cashubtc/nutshell, Marfusios's .NET
 * SDK, the BTCPay Server plugin) hits ID-addressed endpoints only. We follow
 * that pattern.
 *
 * Discovery model: Strike webhooks tell us when something changed; we follow
 * up with GET /v1/invoices/{id} etc. for the actual data.
 *
 *   or-connection-confirm  -> register Strike webhook subscription
 *   Strike -> or-strike-webhook (verify HMAC, queue event)
 *   user clicks Sync       -> drain queue with GET-by-id calls
 *
 * What we emit per sync:
 *   PAID invoices       -> direction='in', type='lightning'
 *   PENDING invoices    -> same, status=PENDING (surfaces as in-flight)
 *   UNPAID invoices     -> skipped (no value moved yet)
 *   CANCELLED invoices  -> skipped (no money moved)
 *
 * NOT in v1 (deliberate scope cuts):
 *   - Payouts (/v1/payouts) - outgoing withdrawals to bank / external wallet
 *   - Deposits (/v1/deposits) - funding Strike from a bank
 *   - Currency exchanges (/v1/currency-exchange-quotes) - internal swaps
 *
 * Test environment: Strike's sandbox is at https://api.dev.strike.me.
 * Merchants generate a read-only API key with the
 * `partner.account.profile.read`, `partner.invoice.read`, and
 * `partner.webhooks.manage` scopes before connecting.
 */

import type {
  ProviderAdapter,
  DiscoveredWallet,
  NormalizedTransaction,
  SyncResult,
} from '../types.ts';

const STRIKE_API = 'https://api.strike.me/v1';

// ─── Types ───────────────────────────────────────────────────────────────

export interface StrikeCredentials {
  api_key: string;
}

export type StrikeInvoiceState = 'UNPAID' | 'PENDING' | 'PAID' | 'CANCELLED';
export type StrikePaymentState = 'PENDING' | 'COMPLETED' | 'FAILED';

export interface StrikeAmount {
  /** Decimal string, e.g. "10.00". */
  amount: string;
  /** ISO 4217 code or 'BTC' / 'USDT' / etc. */
  currency: string;
}

export interface StrikeInvoice {
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
  /** Strike account id of the party that created this invoice. */
  issuerId?: string;
  /** Strike account id of the party that will receive the funds. */
  receiverId?: string;
  payerId?: string;
}

export interface StrikePayment {
  paymentId: string;
  state: StrikePaymentState;
  result: string;
  completed?: string;
  delivered?: string;
  amount: StrikeAmount;
  totalFee: StrikeAmount;
  totalAmount: StrikeAmount;
  description?: string;
}

export type StrikeReceiveState = 'PENDING' | 'COMPLETED' | 'FAILED';

export interface StrikeReceive {
  receiveId: string;
  receiveRequestId: string;
  state: StrikeReceiveState;
  created: string;
  completed?: string;
  amount: StrikeAmount;
  /** Free-form description on the parent receive-request. */
  description?: string;
  /** Strike account id of the party that received the funds. */
  receiverId?: string;
}

export interface StrikeDeposit {
  depositId: string;
  state: string;
  created: string;
  completed?: string;
  amountReceived: StrikeAmount;
  amountCredited?: StrikeAmount;
  description?: string;
}

export interface StrikePayout {
  payoutId: string;
  state: string;
  created: string;
  completed?: string;
  amount: StrikeAmount;
  totalAmount?: StrikeAmount;
  description?: string;
}

export interface StrikeCurrencyExchangeQuote {
  id: string;
  created: string;
  expiration: string;
  sourceAmount: StrikeAmount;
  targetAmount: StrikeAmount;
  conversionRate: { amount: string; sourceCurrency: string; targetCurrency: string };
  state?: string;
}

export interface StrikeBalance {
  currency: string;
  current: string;
  available: string;
  outgoing: string;
  total: string;
}

/** Strike webhook subscription as returned by POST /v1/subscriptions. */
export interface StrikeSubscription {
  id: string;
  webhookUrl: string;
  webhookVersion: 'v1' | 'v2';
  enabled: boolean;
  created: string;
  eventTypes: string[];
}

// ─── Credentials parsing ─────────────────────────────────────────────────

export function parseStrikeCredentials(c: Record<string, unknown>): StrikeCredentials {
  const api_key = c.api_key;
  if (typeof api_key !== 'string' || !api_key.trim()) {
    throw new Error('[strike] credentials.api_key required');
  }
  return { api_key: api_key.trim() };
}

// ─── Low-level HTTP ──────────────────────────────────────────────────────

/**
 * Strike API call. ID-addressed and POST-shaped paths only, list scans
 * with OData query parameters trigger Cloudflare's WAF and return a 403.
 *
 * No special headers needed. The 2026-05-22 User-Agent + Accept-Language
 * mitigation was a red herring: empirical testing proved CF reacts to URL
 * shape, not headers. Keeping the request minimal also matches what every
 * other production Strike caller does.
 */
async function strikeFetch(
  creds: StrikeCredentials,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${creds.api_key}`);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(`${STRIKE_API}${path}`, { ...init, headers });
}

async function strikeGet<T>(creds: StrikeCredentials, path: string): Promise<T> {
  // Empirical 2026-05-25: Cloudflare's WAF triggers specifically on the
  // compound `or` keyword inside an OData $filter clause. Simple per-state
  // `eq` queries and standalone $orderby/$top/$skip pass cleanly. Guard
  // against the known-bad pattern; allow everything else.
  if (/\$filter=[^&]*\bor\b/i.test(path)) {
    throw new Error(
      `[strike] OData $filter with compound "or" clause is blocked by Cloudflare. ` +
      `Issue one call per state and merge client-side instead. Path: ${path}`,
    );
  }
  const res = await strikeFetch(creds, path);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Strike ${res.status} GET ${path}: ${detail.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function strikePost<T>(
  creds: StrikeCredentials,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await strikeFetch(creds, path, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Strike ${res.status} POST ${path}: ${detail.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function strikeDelete(creds: StrikeCredentials, path: string): Promise<void> {
  const res = await strikeFetch(creds, path, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Strike ${res.status} DELETE ${path}: ${detail.slice(0, 200)}`);
  }
}

// ─── High-level API ──────────────────────────────────────────────────────

/** Fetch all currency balances on a Strike account. Used as a liveness check. */
export async function strikeGetBalances(creds: StrikeCredentials): Promise<StrikeBalance[]> {
  return strikeGet<StrikeBalance[]>(creds, '/balances');
}

/** Fetch a single invoice by ID. Webhook handlers use this after invoice.updated events. */
export async function strikeGetInvoiceById(
  creds: StrikeCredentials,
  invoiceId: string,
): Promise<StrikeInvoice> {
  return strikeGet<StrikeInvoice>(creds, `/invoices/${encodeURIComponent(invoiceId)}`);
}

/** Fetch a single payment by ID. Webhook handlers use this after payment.updated events. */
export async function strikeGetPaymentById(
  creds: StrikeCredentials,
  paymentId: string,
): Promise<StrikePayment> {
  return strikeGet<StrikePayment>(creds, `/payments/${encodeURIComponent(paymentId)}`);
}

/**
 * Register a Strike webhook subscription. Called from or-connection-confirm
 * when a Strike connection moves from pending to active.
 *
 * Strike docs: https://docs.strike.me/api/create-subscription
 *
 * The `secret` is the HMAC-SHA256 key Strike will sign payloads with.
 * Generate fresh per subscription. Store on the connection row so
 * or-strike-webhook can verify incoming events.
 */
export async function strikeCreateSubscription(
  creds: StrikeCredentials,
  params: {
    webhookUrl: string;
    secret: string;
    eventTypes: string[];
    webhookVersion?: 'v1' | 'v2';
  },
): Promise<StrikeSubscription> {
  return strikePost<StrikeSubscription>(creds, '/subscriptions', {
    webhookUrl: params.webhookUrl,
    webhookVersion: params.webhookVersion ?? 'v1',
    secret: params.secret,
    enabled: true,
    eventTypes: params.eventTypes,
  });
}

/** Delete a Strike webhook subscription. Called from or-connection-disconnect. */
export async function strikeDeleteSubscription(
  creds: StrikeCredentials,
  subscriptionId: string,
): Promise<void> {
  return strikeDelete(creds, `/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

/**
 * Default set of event types we subscribe to. Covers the full lifecycle for
 * accounting: incoming invoices, outgoing payments, Lightning receives, bank
 * deposits + payouts, and currency exchanges.
 */
export const STRIKE_DEFAULT_EVENT_TYPES = [
  'invoice.created',
  'invoice.updated',
  'payment.created',
  'payment.updated',
  'receive-request.receive-pending',
  'receive-request.receive-completed',
  'deposit.updated',
  'payout.created',
  'payout.updated',
  'currency-exchange-quote.updated',
];

// ─── Additional GET-by-id helpers ────────────────────────────────────────

export async function strikeGetReceiveById(
  creds: StrikeCredentials,
  receiveId: string,
): Promise<StrikeReceive> {
  return strikeGet<StrikeReceive>(creds, `/receive-requests/receives/${encodeURIComponent(receiveId)}`);
}

export async function strikeGetDepositById(
  creds: StrikeCredentials,
  depositId: string,
): Promise<StrikeDeposit> {
  return strikeGet<StrikeDeposit>(creds, `/deposits/${encodeURIComponent(depositId)}`);
}

export async function strikeGetPayoutById(
  creds: StrikeCredentials,
  payoutId: string,
): Promise<StrikePayout> {
  return strikeGet<StrikePayout>(creds, `/payouts/${encodeURIComponent(payoutId)}`);
}

export async function strikeGetExchangeQuoteById(
  creds: StrikeCredentials,
  quoteId: string,
): Promise<StrikeCurrencyExchangeQuote> {
  return strikeGet<StrikeCurrencyExchangeQuote>(creds, `/currency-exchange-quotes/${encodeURIComponent(quoteId)}`);
}

// ─── Normalization ────────────────────────────────────────────────────────
//
// Each normalize function accepts sourceWalletId: the external_wallet_id stored
// on the source_wallet row for this connection (Strike's own per-account id,
// read from issuerId/receiverId during discover()). Webhook handlers should read
// this from the connection record (via DrainConnection.source_wallet_id) rather
// than using a hardcoded constant. syncByWallets reads it from walletIds[0].

/** Pack BTC-or-fiat amount into a NormalizedTransaction. */
function packAmount(
  amount: number,
  currency: string,
): { amount_sats: number } | { amount: number; currency: string } {
  if ((currency || 'USD').toUpperCase() === 'BTC') {
    return { amount_sats: Math.round(amount * 100_000_000) };
  }
  return { amount, currency: currency.toUpperCase() };
}

export function normalizeInvoice(
  invoice: StrikeInvoice,
  sourceWalletId: string,
): NormalizedTransaction | null {
  const amount = Number(invoice.amount?.amount);
  if (!isFinite(amount) || amount <= 0) return null;
  if (invoice.state === 'UNPAID' || invoice.state === 'CANCELLED') return null;

  const description =
    (typeof invoice.description === 'string' && invoice.description) ||
    (typeof invoice.correlationId === 'string' ? `Order ${invoice.correlationId}` : null);
  const ts = invoice.completed || invoice.created;

  return {
    id: invoice.invoiceId,
    adapter: 'strike',
    direction: 'in',
    type: 'lightning',
    description,
    counterparty: null,
    status: invoice.state,
    timestamp: new Date(ts).toISOString(),
    source_wallet_id: sourceWalletId,
    ...packAmount(amount, invoice.amount?.currency || 'USD'),
  };
}

/** Lightning-address receive (a payment landed on a static receive-request URL). */
export function normalizeReceive(
  receive: StrikeReceive,
  sourceWalletId: string,
): NormalizedTransaction | null {
  const amount = Number(receive.amount?.amount);
  if (!isFinite(amount) || amount <= 0) return null;
  if (receive.state !== 'COMPLETED') return null;

  const ts = receive.completed || receive.created;
  return {
    id: `receive:${receive.receiveId}`,
    adapter: 'strike',
    direction: 'in',
    type: 'lightning',
    description: receive.description ?? null,
    counterparty: null,
    status: receive.state,
    timestamp: new Date(ts).toISOString(),
    source_wallet_id: sourceWalletId,
    ...packAmount(amount, receive.amount?.currency || 'USD'),
  };
}

/** Bank/wire deposit (fiat onramp). */
export function normalizeDeposit(
  deposit: StrikeDeposit,
  sourceWalletId: string,
): NormalizedTransaction | null {
  const amt = deposit.amountCredited ?? deposit.amountReceived;
  const amount = Number(amt?.amount);
  if (!isFinite(amount) || amount <= 0) return null;
  if (deposit.state && deposit.state !== 'COMPLETED' && deposit.state !== 'SUCCEEDED') return null;

  const ts = deposit.completed || deposit.created;
  return {
    id: `deposit:${deposit.depositId}`,
    adapter: 'strike',
    direction: 'in',
    type: 'deposit',
    description: deposit.description ?? null,
    counterparty: null,
    status: deposit.state,
    timestamp: new Date(ts).toISOString(),
    source_wallet_id: sourceWalletId,
    ...packAmount(amount, amt?.currency || 'USD'),
  };
}

/** Bank/wire payout (fiat offramp). */
export function normalizePayout(
  payout: StrikePayout,
  sourceWalletId: string,
): NormalizedTransaction | null {
  const amt = payout.totalAmount ?? payout.amount;
  const amount = Number(amt?.amount);
  if (!isFinite(amount) || amount <= 0) return null;
  if (payout.state && payout.state !== 'COMPLETED' && payout.state !== 'SUCCEEDED') return null;

  const ts = payout.completed || payout.created;
  return {
    id: `payout:${payout.payoutId}`,
    adapter: 'strike',
    direction: 'out',
    type: 'withdrawal',
    description: payout.description ?? null,
    counterparty: null,
    status: payout.state,
    timestamp: new Date(ts).toISOString(),
    source_wallet_id: sourceWalletId,
    ...packAmount(amount, amt?.currency || 'USD'),
  };
}

/** Outgoing Lightning payment (webhook-only, Strike exposes no list endpoint). */
export function normalizePayment(
  payment: StrikePayment,
  sourceWalletId: string,
): NormalizedTransaction | null {
  const amount = Number(payment.totalAmount?.amount ?? payment.amount?.amount);
  if (!isFinite(amount) || amount <= 0) return null;
  if (payment.state !== 'COMPLETED') return null;

  const ts = payment.completed || payment.delivered || '';
  return {
    id: `payment:${payment.paymentId}`,
    adapter: 'strike',
    direction: 'out',
    type: 'lightning',
    description: payment.description ?? null,
    counterparty: null,
    status: payment.state,
    timestamp: ts ? new Date(ts).toISOString() : new Date().toISOString(),
    source_wallet_id: sourceWalletId,
    ...packAmount(amount, payment.totalAmount?.currency || payment.amount?.currency || 'USD'),
  };
}

/**
 * Currency exchange, an internal swap from one balance to another.
 * Emitted as an OUT debit from the source currency. The credit to the
 * target currency is reflected in the balance and does not need a
 * separate transaction; this is consistent with how exchange-style
 * transactions are sinked in the V2 yaml profile.
 */
export function normalizeExchange(
  quote: StrikeCurrencyExchangeQuote,
  sourceWalletId: string,
): NormalizedTransaction | null {
  const amount = Number(quote.sourceAmount?.amount);
  if (!isFinite(amount) || amount <= 0) return null;
  if (quote.state && quote.state !== 'COMPLETED' && quote.state !== 'EXECUTED') return null;

  return {
    id: `exchange:${quote.id}`,
    adapter: 'strike',
    direction: 'out',
    type: 'trade',
    description: `Exchange ${quote.sourceAmount.currency} to ${quote.targetAmount.currency}`,
    counterparty: null,
    status: quote.state ?? 'COMPLETED',
    timestamp: new Date(quote.created).toISOString(),
    source_wallet_id: sourceWalletId,
    ...packAmount(amount, quote.sourceAmount?.currency || 'USD'),
  };
}

// ─── Adapter implementation ──────────────────────────────────────────────

/**
 * Discover wallets for a Strike connection.
 *
 * The external_wallet_id is Strike's own stable per-account UUID, read from
 * the issuerId field on the newest invoice (the account that created it, i.e.
 * the merchant/user) or from receiverId on the newest receive. These ids are
 * immutable: they are assigned at account creation and never change.
 *
 * Fetch strategy:
 *   1. GET /balances (liveness + scope check, CF-safe)
 *   2. GET /invoices?$top=1&$orderby=created desc (CF-safe, no compound filter)
 *      -> use issuerId ?? receiverId from the newest invoice
 *   3. If still no id: GET /receive-requests/receives?$top=1&$orderby=created desc
 *      -> use receiverId from the newest receive
 *   4. If still no id: throw a plain user-facing error asking for a first transaction
 *
 * Accounts with only outgoing activity (payments, payouts) will not expose
 * their account id via invoices or receives. The friendly error covers this
 * case and asks the user to make any transaction that generates an invoice
 * or receive record before connecting.
 */
async function discover(_credentials: Record<string, unknown>): Promise<DiscoveredWallet[]> {
  const creds = parseStrikeCredentials(_credentials);

  // Step 1: liveness check. Smallest CF-safe authenticated endpoint.
  await strikeGetBalances(creds);

  // Step 2: read the stable account id from the newest invoice.
  // issuerId = the Strike account that created this invoice (you, the merchant).
  // receiverId = also present on some invoice types; try as a fallback within the same call.
  // A $top=1 + $orderby fetch with no compound filter is CF-safe.
  let accountId: string | undefined;

  try {
    const page = await strikeGet<{ items?: StrikeInvoice[] }>(
      creds,
      '/invoices?$top=1&$orderby=created%20desc',
    );
    const newest = page.items?.[0];
    accountId = newest?.issuerId ?? newest?.receiverId;
  } catch {
    // Invoice fetch failed (empty account or missing scope); try receives next.
  }

  // Step 3: fallback to receiverId from the newest Lightning receive.
  if (!accountId) {
    try {
      const page = await strikeGet<{ items?: StrikeReceive[] }>(
        creds,
        '/receive-requests/receives?$top=1&$orderby=created%20desc',
      );
      accountId = page.items?.[0]?.receiverId;
    } catch {
      // Receive fetch also failed; fall through to the error below.
    }
  }

  // Step 4: no id found. Refuse to connect rather than storing a placeholder.
  if (!accountId) {
    throw new Error(
      "A Strike account with no transactions yet doesn't send us anything that " +
      "identifies it, so we can't connect it. Add your first transaction in Strike, " +
      'then connect again.',
    );
  }

  return [
    {
      external_wallet_id: accountId,
      currency: 'USD',
      label: 'Strike account',
    },
  ];
}

// ─── Sync helpers ────────────────────────────────────────────────────────

const STATES_TO_SYNC: StrikeInvoiceState[] = ['PAID', 'PENDING'];
const PAGE_SIZE = 100;
const MAX_PAGES_PER_STATE = 50; // 5000 invoices per state per sync, plenty

/** True if the error from a Strike list endpoint is a missing-scope 403. */
function isScopeMissing(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /403 GET|Insufficient permissions|FORBIDDEN/i.test(msg);
}

/**
 * Generic newest-first paginator that stops once items older than the cursor
 * appear. Builds the query with $orderby=created desc + $top/$skip; callers
 * supply any additional params (e.g. a per-state $filter) in pageBase.
 */
async function paginateNewestFirst<T extends { created?: string }>(
  creds: StrikeCredentials,
  path: string,
  pageBase: URLSearchParams,
  sinceIso: string | null,
): Promise<T[]> {
  const out: T[] = [];
  let skip = 0;
  for (let page = 0; page < MAX_PAGES_PER_STATE; page++) {
    const params = new URLSearchParams(pageBase);
    params.set('$orderby', 'created desc');
    params.set('$top', String(PAGE_SIZE));
    params.set('$skip', String(skip));
    const data = await strikeGet<{ items?: T[] }>(creds, `${path}?${params.toString()}`);
    const items = data.items ?? [];
    if (items.length === 0) break;
    if (sinceIso) {
      let crossed = false;
      for (const it of items) {
        if (it.created && it.created > sinceIso) {
          out.push(it);
        } else {
          crossed = true;
          break;
        }
      }
      if (crossed) break;
    } else {
      out.push(...items);
    }
    if (items.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }
  return out;
}

/**
 * Fetch all invoices in a single state, newest first, stopping at cursor.
 * CF-safe: single-term $filter (no compound `or`).
 */
async function fetchInvoicesByState(
  creds: StrikeCredentials,
  state: StrikeInvoiceState,
  cursor: string | null,
): Promise<StrikeInvoice[]> {
  const params = new URLSearchParams();
  params.set('$filter', `state eq '${state}'`);
  return paginateNewestFirst<StrikeInvoice>(creds, '/invoices', params, cursor);
}

async function syncByWallets(
  credentials: Record<string, unknown>,
  walletIds: string[],
  cursor: string | null,
): Promise<SyncResult> {
  const creds = parseStrikeCredentials(credentials);
  // walletIds[0] is the real Strike account id returned by discover().
  // The 'strike' fallback only applies to legacy connections that have not
  // yet been remapped; new connections always carry the real id.
  const sourceWalletId = walletIds[0] ?? 'strike';

  const transactions: NormalizedTransaction[] = [];
  let maxSeen = cursor ?? '';
  const trackMax = (iso: string | undefined) => {
    if (iso && iso > maxSeen) maxSeen = iso;
  };

  // 1) Invoices, fetched per-state to avoid CF-blocked compound $filter.
  for (const state of STATES_TO_SYNC) {
    try {
      const batch = await fetchInvoicesByState(creds, state, cursor);
      for (const inv of batch) {
        const norm = normalizeInvoice(inv, sourceWalletId);
        if (norm) transactions.push(norm);
        trackMax(inv.created);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[strike] invoice ${state} fetch failed (will continue): ${msg.slice(0, 200)}`);
    }
  }

  // 2) Lightning receives (payments to a static Lightning address).
  try {
    const receives = await paginateNewestFirst<StrikeReceive>(
      creds, '/receive-requests/receives', new URLSearchParams(), cursor,
    );
    for (const r of receives) {
      const norm = normalizeReceive(r, sourceWalletId);
      if (norm) transactions.push(norm);
      trackMax(r.created);
    }
  } catch (err) {
    if (isScopeMissing(err)) {
      console.warn('[strike] receive-request scope missing, skipping.');
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[strike] receives fetch failed (will continue): ${msg.slice(0, 200)}`);
    }
  }

  // Note: Deposits, payouts, and currency exchanges are NOT in v1 scope
  // (see file header). Normalize functions exist for the webhook drain path
  // and future polling; the sync loop does not poll those endpoints yet.

  transactions.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));

  return {
    transactions,
    next_cursor: maxSeen || null,
  };
}

async function syncAccountWide(
  credentials: Record<string, unknown>,
  cursor: string | null,
): Promise<SyncResult> {
  const wallets = await discover(credentials);
  const walletIds = wallets.map((w) => w.external_wallet_id);
  return syncByWallets(credentials, walletIds, cursor);
}

// ─── Adapter export ──────────────────────────────────────────────────────

export const strikeAdapter: ProviderAdapter = {
  slug: 'strike',
  displayName: 'Strike',
  description: 'Lightning + USD',
  category: 'lightning_wallet',
  tags: ['lightning', 'us', 'eu', 'fiat-on-ramp', 'custodial'],
  popularity: 88,
  multiWallet: false,
  credentialFields: [
    {
      name: 'api_key',
      type: 'secret',
      label: 'Strike API key',
      placeholder: 'token-...',
      helpLabel: 'Get one at dashboard.strike.me (API Key section)',
      helpHref: 'https://dashboard.strike.me/',
    },
  ],
  discoverWallets: discover,
  syncByWallets,
  syncAccountWide,
};
