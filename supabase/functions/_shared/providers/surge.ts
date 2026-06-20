/**
 * Surge source adapter — Bitcoin-backed lending positions on Base.
 *
 * Listed under category 'lender' in OrangeRails-Protocol §18. Surge issues
 * USDC against Bitcoin collateral; each loan is an EVM NFT held by the
 * borrower. We read Surge's borrower-scoped Partner API (read-only,
 * borrower-bound, user-revocable) and emit one NormalizedTransaction per
 * loan-level event.
 *
 * Auth model. The borrower signs a canonical EIP-191 personal_sign message
 * with the EVM wallet that owns their position NFT. The signature + claims
 * are packaged into a base64url(JSON) envelope — the bearer token. OR never
 * inspects, signs, or rotates the token; we carry it. The borrower address
 * IS bound into the token envelope, so users only paste the token; we
 * decode the envelope to learn which borrower to query.
 *
 * Two wallets per Surge position. Each Surge loan moves money in two
 * currencies (BTC collateral, USDC line of credit), so we emit two
 * DiscoveredWallets per position to keep transactions single-currency per
 * source_wallet. Position 226 → wallets `surge:position:226:btc` (BTC) +
 * `surge:position:226:usdc` (USDC). Loan-opened (with collateral),
 * collateral_added, collateral_withdrawn route to the BTC wallet;
 * borrowed and repaid route to the USDC wallet.
 *
 * Cursor (v1). Unused — every sync fetches the full event window
 * (Surge caps `limit=250`). Per-connection (external_id) UNIQUE on the
 * V2/V3 transactions table dedups. Cheap and correct as long as a single
 * borrower has <250 lifetime events; v1.1 will add `before=<event_id>`
 * pagination once Surge ships it.
 *
 * Field availability. Surge's v1.1 release returns nulls (not estimates)
 * for `rate_apr_bps`, `ltv_bps`, `accrued_interest_usdc`, etc. We pass
 * through whatever they send; null fields don't produce transactions, they
 * just live on the position record.
 */

import type {
  ProviderAdapter,
  DiscoveredWallet,
  NormalizedTransaction,
  SyncResult,
} from './types.ts';

// ─── Constants ───────────────────────────────────────────────────────────

const DEFAULT_SURGE_API_BASE = 'https://test.partner.api.surge.dev/api/v1';
const EVENT_PAGE_LIMIT = 250;
const USER_AGENT = 'OrangeRails/0.2 (noreply@orangerails.com)';

// ─── Credential parsing ─────────────────────────────────────────────────

interface SurgeCredentials {
  bearer_token: string;
  /** Decoded from the token envelope; not user-supplied. */
  borrower: string;
}

interface SurgeTokenEnvelope {
  v: number;
  borrower: string;
  partner: string;
  scope: string;
  env: string;
  chainId: number;
  issuedAt: number;
  nonce: string;
  sig: string;
}

function base64urlDecodeToString(s: string): string {
  // Pad and translate base64url to base64 for atob compatibility on Deno.
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const std = padded.replace(/-/g, '+').replace(/_/g, '/');
  // atob is available in Deno globals.
  return atob(std);
}

function decodeTokenEnvelope(token: string): SurgeTokenEnvelope {
  if (token.length > 4096) {
    throw new Error('[surge] bearer_token exceeds 4096 chars');
  }
  let raw: string;
  try {
    raw = base64urlDecodeToString(token);
  } catch (err) {
    throw new Error(
      `[surge] bearer_token is not valid base64url: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let env: unknown;
  try {
    env = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[surge] bearer_token envelope is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!env || typeof env !== 'object') {
    throw new Error('[surge] bearer_token envelope must be an object');
  }
  const e = env as Record<string, unknown>;
  for (const k of ['borrower', 'partner', 'scope', 'env', 'sig']) {
    if (typeof e[k] !== 'string') {
      throw new Error(`[surge] bearer_token envelope missing field: ${k}`);
    }
  }
  const borrower = e.borrower as string;
  if (!/^0x[0-9a-fA-F]{40}$/.test(borrower)) {
    throw new Error('[surge] bearer_token envelope borrower is not an EVM address');
  }
  return env as SurgeTokenEnvelope;
}

function parseSurgeCredentials(credentials: Record<string, unknown>): SurgeCredentials {
  const bt = credentials.bearer_token;
  if (typeof bt !== 'string' || bt.length === 0) {
    throw new Error('[surge] credentials.bearer_token required');
  }
  const env = decodeTokenEnvelope(bt);
  return { bearer_token: bt, borrower: env.borrower };
}

// ─── HTTP ────────────────────────────────────────────────────────────────

function surgeBase(): string {
  return Deno.env.get('SURGE_API_BASE') ?? DEFAULT_SURGE_API_BASE;
}

async function surgeGet<T>(path: string, token: string): Promise<T> {
  const url = `${surgeBase()}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch (_) {
    /* tolerate non-JSON */
  }
  const obj = (body ?? {}) as { success?: boolean; data?: unknown; error?: { code?: string; message?: string } };
  if (!res.ok || obj.success !== true) {
    const code = obj.error?.code ?? `http_${res.status}`;
    const msg = obj.error?.message ?? `Surge HTTP ${res.status}`;
    throw new Error(`[surge:${code}] ${msg}`);
  }
  return obj.data as T;
}

// ─── Surge response shapes (v1.1) ───────────────────────────────────────

interface SurgePosition {
  position_id: string;
  nft_id: number;
  chain_id: number;
  borrower_address: string;
  vault_address: string | null;
  market_id: number | null;
  status: 'active' | 'closed';
  collateral_asset: 'BTC';
  collateral_sats: string;
  collateral_btc: number;
  debt_asset: 'USDC';
  principal_usdc: string;
  principal_usdc_amount: number;
  accrued_interest_usdc: string | null;
  rate_type: string | null;
  rate_apr_bps: number | null;
  ltv_bps: number | null;
  liquidation_threshold_bps: number | null;
  last_settlement_at: string | null;
  last_position_update_at: string | null;
}

interface SurgeUsdcAmount { usdc: string; usdc_amount: number; }
interface SurgeBtcAmount { sats: string; btc: number; }

interface SurgeEvent {
  id: string;
  action: 'loan_opened' | 'borrowed' | 'repaid' | 'collateral_added' | 'collateral_withdrawn';
  source: string;
  position_id: string | null;
  market_id: number | null;
  occurred_at: string | null;
  block_number: number;
  transaction_hash: string;
  debt: SurgeUsdcAmount | null;
  repaid: SurgeUsdcAmount | null;
  collateral: SurgeBtcAmount | null;
  remaining_debt: SurgeUsdcAmount | null;
}

// ─── Wallet helpers ──────────────────────────────────────────────────────

function btcWalletId(positionId: string): string { return `surge:position:${positionId}:btc`; }
function usdcWalletId(positionId: string): string { return `surge:position:${positionId}:usdc`; }

function positionLabel(p: SurgePosition, asset: 'BTC' | 'USDC'): string {
  const suffix = p.status === 'closed' ? ' (closed)' : '';
  return asset === 'BTC'
    ? `Surge loan #${p.position_id} — BTC collateral${suffix}`
    : `Surge loan #${p.position_id} — USDC line${suffix}`;
}

// ─── Event → NormalizedTransaction routing ──────────────────────────────

/**
 * Map a Surge event to zero or one NormalizedTransaction. Returns null when
 * the event has no money movement (e.g. loan_opened without folded
 * collateral) or when the event has no position attribution and the caller
 * asked for wallet-scoped sync.
 */
function eventToTx(
  e: SurgeEvent,
  opts: { sourceWalletId: string | null; requireWallet: boolean },
): NormalizedTransaction | null {
  if (e.position_id == null && opts.requireWallet) return null;
  const timestamp = e.occurred_at ?? new Date(0).toISOString();
  const baseTx = (overrides: Partial<NormalizedTransaction>): NormalizedTransaction => ({
    id: e.id,
    adapter: 'surge',
    direction: 'in',
    type: 'deposit',
    timestamp,
    description: `Surge: ${e.action} (loan ${e.position_id ?? 'pool'})`,
    counterparty: 'Surge',
    status: 'confirmed',
    source_wallet_id: opts.sourceWalletId,
    ...overrides,
  });

  switch (e.action) {
    case 'loan_opened':
      // Surge folds the opening collateral deposit into this event when it
      // exists. If collateral is null, the actual deposit is a separate
      // collateral_added event — skip here to avoid emitting a 0-sat tx.
      if (e.collateral == null) return null;
      return baseTx({
        direction: 'in',
        type: 'deposit',
        amount_sats: Number(e.collateral.sats),
        currency: 'BTC',
      });

    case 'collateral_added':
      if (e.collateral == null) return null;
      return baseTx({
        direction: 'in',
        type: 'deposit',
        amount_sats: Number(e.collateral.sats),
        currency: 'BTC',
      });

    case 'collateral_withdrawn':
      if (e.collateral == null) return null;
      return baseTx({
        direction: 'out',
        type: 'withdrawal',
        amount_sats: Number(e.collateral.sats),
        currency: 'BTC',
      });

    case 'borrowed':
      if (e.debt == null) return null;
      return baseTx({
        direction: 'in',
        type: 'deposit',
        amount: e.debt.usdc_amount,
        currency: 'USDC',
      });

    case 'repaid':
      if (e.repaid == null) return null;
      return baseTx({
        direction: 'out',
        type: 'withdrawal',
        amount: e.repaid.usdc_amount,
        currency: 'USDC',
      });

    default:
      return null;
  }
}

function isBtcEvent(action: SurgeEvent['action']): boolean {
  return action === 'loan_opened' || action === 'collateral_added' || action === 'collateral_withdrawn';
}

// ─── Adapter ─────────────────────────────────────────────────────────────

export const surgeAdapter: ProviderAdapter = {
  slug: 'surge',
  displayName: 'Surge',
  description: 'Bitcoin-backed USDC line of credit on Base',
  status: 'beta',
  category: 'lender',
  tags: ['lender', 'btc-backed', 'usdc', 'base', 'evm', 'us'],
  popularity: 80,

  credentialFields: [
    {
      name: 'bearer_token',
      type: 'secret',
      label: 'Surge Partner API token',
      placeholder: 'Paste the token from Surge Credit → Settings → Integrations → BitBooks → Generate',
      multiline: true,
      helpLabel: 'How to generate this token',
      helpHref: 'https://maintainer-only/doc/integration-surge-orange-rails-3vbNhDWMUO',
    },
  ],

  multiWallet: true,

  async discoverWallets(credentials: Record<string, unknown>): Promise<DiscoveredWallet[]> {
    const creds = parseSurgeCredentials(credentials);
    const positions = await surgeGet<SurgePosition[]>(
      `/borrowers/${creds.borrower}/positions`,
      creds.bearer_token,
    );
    const wallets: DiscoveredWallet[] = [];
    for (const p of positions) {
      wallets.push({ external_wallet_id: btcWalletId(p.position_id), currency: 'BTC', label: positionLabel(p, 'BTC') });
      wallets.push({ external_wallet_id: usdcWalletId(p.position_id), currency: 'USDC', label: positionLabel(p, 'USDC') });
    }
    return wallets;
  },

  async syncByWallets(
    credentials: Record<string, unknown>,
    walletIds: string[],
    _cursor: string | null,
  ): Promise<SyncResult> {
    const creds = parseSurgeCredentials(credentials);
    const events = await surgeGet<SurgeEvent[]>(
      `/borrowers/${creds.borrower}/events?limit=${EVENT_PAGE_LIMIT}&raw=0`,
      creds.bearer_token,
    );

    // Map walletId → expected (positionId, assetKind) so we can route each
    // event to the right wallet (or drop it if the user didn't pick that
    // position's wallet).
    const accepted = new Map<string, 'btc' | 'usdc'>();
    for (const w of walletIds) {
      const m = w.match(/^surge:position:(.+):(btc|usdc)$/);
      if (m) accepted.set(`${m[1]}:${m[2]}`, m[2] as 'btc' | 'usdc');
    }

    const out: NormalizedTransaction[] = [];
    for (const e of events) {
      if (e.position_id == null) continue;
      const assetKind = isBtcEvent(e.action) ? 'btc' : 'usdc';
      const key = `${e.position_id}:${assetKind}`;
      if (!accepted.has(key)) continue;
      const walletId = assetKind === 'btc' ? btcWalletId(e.position_id) : usdcWalletId(e.position_id);
      const tx = eventToTx(e, { sourceWalletId: walletId, requireWallet: true });
      if (tx) out.push(tx);
    }
    return { transactions: out, next_cursor: null };
  },

  async syncAccountWide(
    credentials: Record<string, unknown>,
    _cursor: string | null,
  ): Promise<SyncResult> {
    const creds = parseSurgeCredentials(credentials);
    const events = await surgeGet<SurgeEvent[]>(
      `/borrowers/${creds.borrower}/events?limit=${EVENT_PAGE_LIMIT}&raw=0`,
      creds.bearer_token,
    );
    const out: NormalizedTransaction[] = [];
    for (const e of events) {
      // Account-wide path still routes to a position-scoped wallet when one
      // exists; downstream UIs render the per-wallet stream more naturally
      // than null-wallet rows. Pool-level events keep null.
      let walletId: string | null = null;
      if (e.position_id != null) {
        walletId = isBtcEvent(e.action) ? btcWalletId(e.position_id) : usdcWalletId(e.position_id);
      }
      const tx = eventToTx(e, { sourceWalletId: walletId, requireWallet: false });
      if (tx) out.push(tx);
    }
    return { transactions: out, next_cursor: null };
  },
};
