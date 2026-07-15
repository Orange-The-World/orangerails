/**
 * Strike source adapter , https://strike.me Lightning + multi-currency wallet.
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
 * ════════════════════════════════════════════════════════════════════════
 * Architecture: webhook-driven, never OData list scans
 * ════════════════════════════════════════════════════════════════════════
 *
 * Strike's api.strike.me sits behind Cloudflare's Bot Management. Empirical
 * testing on 2026-05-25 from multiple egress points (Supabase Edge AWS,
 * OVH Quebec, residential) with three header configurations (bare, Marfusios's
 * .NET SDK pattern, current OR) proved that Cloudflare challenges requests
 * by URL SHAPE, not TLS fingerprint or User-Agent:
 *
 *   GET /v1/balances                       → 200 OK, JSON               ✓
 *   GET /v1/invoices/{id}                  → 200 / 404, JSON            ✓
 *   GET /v1/invoices?$filter=...&$top=...  → 403, "Just a moment" HTML  ✗
 *
 * Cloudflare's WAF flags the OData `$`-prefixed query parameters as
 * injection-shaped traffic. No client-side fix (UA, cookies, TLS spoof)
 * changes this , only the URL shape matters.
 *
 * Every other production Strike caller (cashubtc/nutshell, Marfusios's .NET
 * SDK, the BTCPay Server plugin, all 30+ community SDKs) hits ID-addressed
 * endpoints exclusively. We follow that pattern.
 *
 * Discovery model: Strike webhooks tell us when something changed; we
 * follow up with `GET /v1/invoices/{id}` etc. for the actual data.
 *
 *   or-connection-confirm  → register Strike webhook subscription
 *   Strike → or-strike-webhook (verify HMAC, queue event)
 *   user clicks Sync       → drain queue with GET-by-id calls
 *
 *
 * What we emit per sync (post-PR2 when queue drain ships):
 *   PAID invoices       → direction='in', type='lightning'
 *   PENDING invoices    → same, status=PENDING (surfaces as in-flight)
 *   UNPAID invoices     → skipped (no value moved yet)
 *   CANCELLED invoices  → skipped (no money moved)
 *
 * NOT in v1 (deliberate scope cuts):
 *   - Payouts (`/v1/payouts`) , outgoing withdrawals to bank / external wallet
 *   - Deposits (`/v1/deposits`) , funding Strike from a bank
 *   - Currency exchanges (`/v1/currency-exchange-quotes`) , internal swaps
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
const SOURCE_WALLET_ID = 'strike';

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
  issuerId?: string;
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
 * Strike API call. ID-addressed and POST-shaped paths only , list scans
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
 * when a Strike connection moves from pending → active.
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

// ─── Normalization (used by webhook drain in PR 2) ────────────────────────

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

export function normalizeInvoice(invoice: StrikeInvoice): NormalizedTransaction | null {
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
    source_wallet_id: SOURCE_WALLET_ID,
    ...packAmount(amount, invoice.amount?.currency || 'USD'),
  };
}

/** Lightning-address receive (a payment landed on a static receive-request URL). */
export function normalizeReceive(receive: StrikeReceive): NormalizedTransaction | null {
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
    source_wallet_id: SOURCE_WALLET_ID,
    ...packAmount(amount, receive.amount?.currency || 'USD'),
  };
}

/** Bank/wire deposit (fiat onramp). */
export function normalizeDeposit(deposit: StrikeDeposit): NormalizedTransaction | null {
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
    source_wallet_id: SOURCE_WALLET_ID,
    ...packAmount(amount, amt?.currency || 'USD'),
  };
}

/** Bank/wire payout (fiat offramp). */
export function normalizePayout(payout: StrikePayout): NormalizedTransaction | null {
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
    source_wallet_id: SOURCE_WALLET_ID,
    ...packAmount(amount, amt?.currency || 'USD'),
  };
}

/** Outgoing Lightning payment (webhook-only , Strike exposes no list endpoint). */
export function normalizePayment(payment: StrikePayment): NormalizedTransaction | null {
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
    source_wallet_id: SOURCE_WALLET_ID,
    ...packAmount(amount, payment.totalAmount?.currency || payment.amount?.currency || 'USD'),
  };
}

/**
 * Currency exchange , an internal swap from one balance to another.
 * Emitted as an OUT debit from the source currency. The credit to the
 * target currency is reflected in the balance and doesn't need a
 * separate transaction; this is consistent with how exchange-style
 * transactions are sinked in the V2 yaml profile.
 */
export function normalizeExchange(quote: StrikeCurrencyExchangeQuote): NormalizedTransaction | null {
  const amount = Number(quote.sourceAmount?.amount);
  if (!isFinite(amount) || amount <= 0) return null;
  if (quote.state && quote.state !== 'COMPLETED' && quote.state !== 'EXECUTED') return null;

  return {
    id: `exchange:${quote.id}`,
    adapter: 'strike',
    direction: 'out',
    type: 'trade',
    description: `Exchange ${quote.sourceAmount.currency} → ${quote.targetAmount.currency}`,
    counterparty: null,
    status: quote.state ?? 'COMPLETED',
    timestamp: new Date(quote.created).toISOString(),
    source_wallet_id: SOURCE_WALLET_ID,
    ...packAmount(amount, quote.sourceAmount?.currency || 'USD'),
  };
}

// ─── Adapter implementation ──────────────────────────────────────────────

async function discover(_credentials: Record<string, unknown>): Promise<DiscoveredWallet[]> {
  // Validate the key up front by calling /v1/balances (the lightest CF-safe
  // endpoint). This proves the key works and gives the user immediate
  // feedback if they pasted the wrong value.
  const creds = parseStrikeCredentials(_credentials);
  await strikeGetBalances(creds); // throws if 401 / 403 / etc.

  // /v1/balances returns currency totals but no account identifier. We use
  // receiverId from a recent invoice as the stable per-account key.
  //
  // Why receiverId, not issuerId:
  //   issuerId  = the account that CREATED the invoice = the integration/partner
  //               context, SHARED across every account connected through the
  //               same API integration. Two distinct Strike accounts will have
  //               the SAME issuerId and would collide into one wallet.
  //   receiverId = the RECIPIENT account = the connected customer's own Strike
  //                account id. This is unique and stable per account.
  // Verified 2026-07-15 against two live E2E keys: same issuerId, different
  // receiverId. Reference: docs.strike.me/api/get-invoices.
  //
  // This is a server-side call inside or-discover-wallets. Strike's invoice
  // list is CORS-blocked from the browser, which is why the old discover()
  // returned the synthetic constant 'strike'. Running server-side removes
  // the CORS barrier entirely.
  const page = await strikeGet<{ count?: number; items?: StrikeInvoice[] }>(
    creds,
    '/invoices?$top=1',
  );
  const firstInvoice = page.items?.[0];
  if (!firstInvoice) {
    // New accounts with no invoices yet have no discoverable identity.
    // Per our policy: no readable identifier -> friendly error, create nothing.
    throw new Error(
      'No invoices found on this Strike account yet. ' +
      'Please connect after your first invoice has been created.',
    );
  }
  const { receiverId } = firstInvoice;
  if (!receiverId) {
    // receiverId should be present on every invoice but guard explicitly.
    throw new Error(
      'Strike did not return an account identifier on the latest invoice. ' +
      'Please try again or contact support if this persists.',
    );
  }

  return [
    {
      external_wallet_id: receiverId,
      currency: 'USD',
      label: 'Strike account',
    },
  ];
}

/**
 * Backfill polling for historical invoices, plus the cursor-based delta sync
 * that runs on every user-initiated Sync click.
 *
 * Architecture (2026-05-25 V3 ADR): Strike's Cloudflare WAF blocks compound
 * `$filter=(state eq 'PAID' or state eq 'PENDING')` expressions (the `or`
 * keyword in the filter clause is the specific trigger). Simple per-state
 * `$filter=(state eq 'PAID')` queries pass cleanly. So we issue ONE call per
 * state we care about and merge client-side. Pagination via `$skip` + `$top`
 * works without triggering CF.
 *
 * On top of this:
 * - or-strike-webhook + strike-queue handles real-time updates after initial
 *   backfill (the queued events are drained by or-sync's Strike branch)
 * - This polling path handles BOTH first-time backfill AND ongoing catchup
 *   for transactions that webhooks may have missed (Strike's docs don't
 *   commit to webhook retry SLAs)
 *
 * Cursor: highest `created` ISO timestamp seen across the merged batch.
 * Next sync filters by `created ge datetime'<iso>'` per state to fetch only
 * what's new.
 */
const STATES_TO_SYNC: StrikeInvoiceState[] = ['PAID', 'PENDING'];
const PAGE_SIZE = 100;
const MAX_PAGES_PER_STATE = 50; // 5000 invoices per state per sync , plenty

/** True if the error from a Strike list endpoint is a missing-scope 403. */
function isScopeMissing(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /403 GET|Insufficient permissions|FORBIDDEN/i.test(msg);
}

/** Generic newest-first paginator that stops once items older than cursor appear. */
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
        if (it.created && it.created > sinceIso) out.push(it);
        else { crossed = true; break; }
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
 * Empirical CF rule (refined 2026-05-25 V3 ADR, then again later same day):
 * Cloudflare blocks ANY compound `$filter` clause , both `or` and `and`
 * triggers fail. The `datetime'<iso>'` literal appears to compound the issue.
 *
 * Workaround: only filter on `state eq '<S>'` (the simple case CF allows).
 * Page through newest-first via $orderby=created desc + $top + $skip. Stop
 * client-side once we've passed the cursor , no date in $filter at all.
 *
 * Cost: on each sync we re-traverse from newest until we hit the cursor.
 * For typical accounts (<5000 invoices, all newer than cursor returns in
 * < N pages) this is fine. For massive accounts the alternative is a
 * partner-tier API access we don't have.
 */
async function fetchInvoicesByState(
  creds: StrikeCredentials,
  state: StrikeInvoiceState,
  sinceIso: string | null,
): Promise<StrikeInvoice[]> {
  const out: StrikeInvoice[] = [];
  let skip = 0;
  for (let page = 0; page < MAX_PAGES_PER_STATE; page++) {
    const params = new URLSearchParams();
    // ONLY simple per-state $filter. NO `and`, NO `or`, NO date literals
    // (all three patterns trip Strike's CF Bot Management WAF).
    params.set('$filter', `state eq '${state}'`);
    // Newest first so we can short-circuit when we cross the cursor.
    params.set('$orderby', 'created desc');
    params.set('$top', String(PAGE_SIZE));
    params.set('$skip', String(skip));
    const data = await strikeGet<{ items?: StrikeInvoice[] }>(creds, `/invoices?${params.toString()}`);
    const items = data.items ?? [];
    if (items.length === 0) break;

    if (sinceIso) {
      let crossed = false;
      for (const inv of items) {
        if (inv.created > sinceIso) {
          out.push(inv);
        } else {
          // Hit our cursor , anything below this is already-synced data.
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

async function syncByWallets(
  credentials: Record<string, unknown>,
  _walletIds: string[],
  cursor: string | null,
): Promise<SyncResult> {
  const creds = parseStrikeCredentials(credentials);

  const transactions: NormalizedTransaction[] = [];
  let maxSeen = cursor ?? '';
  const trackMax = (iso: string | undefined) => {
    if (iso && iso > maxSeen) maxSeen = iso;
  };

  // 1) Invoices , per-state (CF blocks compound `or`)
  for (const state of STATES_TO_SYNC) {
    try {
      const batch = await fetchInvoicesByState(creds, state, cursor);
      for (const inv of batch) {
        const norm = normalizeInvoice(inv);
        if (norm) transactions.push(norm);
        trackMax(inv.created);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[strike] invoice ${state} fetch failed (will continue with other resources): ${msg.slice(0, 200)}`);
    }
  }

  // 2) Lightning receives (static receive-request endpoints)
  try {
    const params = new URLSearchParams();
    const receives = await paginateNewestFirst<StrikeReceive>(
      creds, '/receive-requests/receives', params, cursor,
    );
    for (const r of receives) {
      const norm = normalizeReceive(r);
      if (norm) transactions.push(norm);
      trackMax(r.created);
    }
  } catch (err) {
    if (isScopeMissing(err)) {
      console.warn('[strike] receive-request scope missing , skipping. Add partner.receive-request.read.');
    }
  }

  // 3) Deposits (fiat onramp)
  try {
    const params = new URLSearchParams();
    const deposits = await paginateNewestFirst<StrikeDeposit>(
      creds, '/deposits', params, cursor,
    );
    for (const d of deposits) {
      const norm = normalizeDeposit(d);
      if (norm) transactions.push(norm);
      trackMax(d.created);
    }
  } catch (err) {
    if (isScopeMissing(err)) {
      console.warn('[strike] deposit scope missing , skipping. Add partner.deposit.read.');
    }
  }

  // 4) Payouts (fiat offramp)
  try {
    const params = new URLSearchParams();
    const payouts = await paginateNewestFirst<StrikePayout>(
      creds, '/payouts', params, cursor,
    );
    for (const p of payouts) {
      const norm = normalizePayout(p);
      if (norm) transactions.push(norm);
      trackMax(p.created);
    }
  } catch (err) {
    if (isScopeMissing(err)) {
      console.warn('[strike] payout scope missing , skipping. Add partner.payout.read.');
    }
  }

  // 5) Currency exchange quotes (internal swaps)
  try {
    const params = new URLSearchParams();
    const quotes = await paginateNewestFirst<StrikeCurrencyExchangeQuote>(
      creds, '/currency-exchange-quotes', params, cursor,
    );
    for (const q of quotes) {
      const norm = normalizeExchange(q);
      if (norm) transactions.push(norm);
      trackMax(q.created);
    }
  } catch (err) {
    if (isScopeMissing(err)) {
      console.warn('[strike] currency-exchange-quote scope missing , skipping. Add partner.currency-exchange-quote.read.');
    }
  }

  // Outgoing Lightning payments have NO list endpoint on Strike's API.
  // They arrive via webhooks only (drainStrikeQueue handles payment.* events).

  // Sort newest first for consistent persistence order.
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
  return syncByWallets(credentials, [SOURCE_WALLET_ID], cursor);
}

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
