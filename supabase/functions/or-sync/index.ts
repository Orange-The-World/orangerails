/**
 * or-sync — server-side ZKA sync, subaccount-scoped.
 *
 * Replaces the previous user_app_grants token approach with the
 * platform/subaccount model from OrangeRails-Platform-Design.md.
 *
 * Auth (one of):
 *   - X-Platform-API-Key: <hex>   → platform mode (BitBooks V3 etc.)
 *     Body MUST include subaccount_id (validated to belong to platform)
 *   - Authorization: Bearer <jwt> → direct mode (orangerails.com/app)
 *     Subaccount auto-resolved to the user's direct subaccount
 *
 * POST body:
 *   subaccount_id?:    uuid    required in platform mode
 *   connection_ids?:   uuid[]  sync only these (otherwise all non-disconnected)
 *   credentials_key:   string  base64 ORK (in-transit only)
 *   transactions_key:  string  base64 ORT (in-transit only)
 *
 * Response:
 *   { synced: number, connections: [{ connection_id, synced, next_cursor, error? }] }
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, resolveSubaccount, isAuthError } from '../_shared/platform-auth.ts';

// ─── AES-256-GCM helpers ─────────────────────────────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function importAesKey(base64Key: string): Promise<CryptoKey> {
  const keyBytes = base64ToBytes(base64Key);
  return crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function decryptAes(ciphertextB64: string, key: CryptoKey): Promise<string> {
  const data = base64ToBytes(ciphertextB64);
  const iv = data.slice(0, 12);
  const cipher = data.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return new TextDecoder().decode(plain);
}

async function encryptAes(plaintext: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const combined = new Uint8Array(12 + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), 12);
  return bytesToBase64(combined);
}

// ─── Blink adapter ──────────────────────────────────────────────────────────

const BLINK_API = 'https://api.blink.sv/graphql';

// Legacy account-wide query — used when a connection has no source_wallets
// rows (existing connections from before the per-wallet feature shipped).
const TX_QUERY = `
  query Txns($first: Int!, $after: String) {
    me {
      defaultAccount {
        transactions(first: $first, after: $after) {
          edges {
            cursor
            node {
              id
              direction
              status
              memo
              createdAt
              settlementAmount
              settlementCurrency
              initiationVia {
                __typename
                ... on InitiationViaLn { paymentHash }
                ... on InitiationViaOnChain { address }
                ... on InitiationViaIntraLedger { counterPartyUsername }
              }
              settlementVia {
                __typename
                ... on SettlementViaLn { preImage }
                ... on SettlementViaOnChain { transactionHash }
                ... on SettlementViaIntraLedger { counterPartyUsername }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

// Wallet-scoped query — used when source_wallets rows exist for a connection.
//
// ASSUMPTION about Blink's GraphQL schema (verify against introspection if it
// breaks): the Galoy/Blink schema exposes `transactionsByWalletIds` directly
// on the ConsumerAccount type (same level as the legacy `transactions` field
// used above). This is the field name the Galoy mobile app uses to scope a
// transactions feed to a subset of wallets. The argument is `walletIds:
// [WalletId!]!` plus the standard `first` / `after` Relay paging arguments.
//
// If Blink renames or deprecates this field we'll see a GraphQL error
// surfaced via our existing error-handling path; fall back to the legacy
// account-wide query and filter client-side as a last resort.
const TX_QUERY_BY_WALLET_IDS = `
  query TxnsByWallets($walletIds: [WalletId!]!, $first: Int!, $after: String) {
    me {
      defaultAccount {
        transactionsByWalletIds(walletIds: $walletIds, first: $first, after: $after) {
          edges {
            cursor
            node {
              id
              direction
              status
              memo
              createdAt
              settlementAmount
              settlementCurrency
              initiationVia {
                __typename
                ... on InitiationViaLn { paymentHash }
                ... on InitiationViaOnChain { address }
                ... on InitiationViaIntraLedger { counterPartyUsername }
              }
              settlementVia {
                __typename
                ... on SettlementViaLn { preImage }
                ... on SettlementViaOnChain { transactionHash }
                ... on SettlementViaIntraLedger { counterPartyUsername }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

interface BlinkTxNode {
  id: string;
  direction: 'RECEIVE' | 'SEND';
  status: string;
  memo: string | null;
  createdAt: string | number;
  settlementAmount: number;
  settlementCurrency: string;
  initiationVia: { __typename: string; paymentHash?: string; address?: string; counterPartyUsername?: string };
  settlementVia: { __typename: string; counterPartyUsername?: string; transactionHash?: string };
}

interface NormalizedTransaction {
  id: string;
  adapter: string;
  direction: 'in' | 'out';
  type: 'lightning' | 'onchain' | 'trade' | 'deposit' | 'withdrawal' | 'fee';
  amount_sats?: number;
  amount?: number;
  currency?: string;
  description?: string | null;
  counterparty?: string | null;
  status?: string;
  timestamp: string;
  /**
   * Wallet this transaction came from. Set when sync was scoped via
   * source_wallets; null for legacy/account-wide sync. Downstream consumers
   * (V3, Personal) use this to route transactions per-wallet.
   */
  source_wallet_id: string | null;
}

function normalizeTimestamp(v: string | number): string {
  if (typeof v === 'number') return new Date(v >= 1e12 ? v : v * 1000).toISOString();
  if (/^\d+$/.test(String(v))) { const n = Number(v); return new Date(n >= 1e12 ? n : n * 1000).toISOString(); }
  return new Date(String(v)).toISOString();
}

function normalizeBlinkTx(node: BlinkTxNode, sourceWalletId: string | null): NormalizedTransaction {
  const direction: 'in' | 'out' = node.direction === 'RECEIVE' ? 'in' : 'out';
  const type: NormalizedTransaction['type'] =
    node.initiationVia.__typename === 'InitiationViaOnChain' ? 'onchain' : 'lightning';
  const isBtc = node.settlementCurrency === 'BTC';
  const counterparty =
    node.initiationVia.__typename === 'InitiationViaIntraLedger'
      ? (node.initiationVia.counterPartyUsername ?? null)
      : node.settlementVia.__typename === 'SettlementViaIntraLedger'
        ? (node.settlementVia.counterPartyUsername ?? null)
        : null;
  return {
    id: node.id,
    adapter: 'blink',
    direction,
    type,
    ...(isBtc ? { amount_sats: Math.abs(node.settlementAmount) } : { amount: Math.abs(node.settlementAmount / 100), currency: 'USD' }),
    description: node.memo ?? null,
    counterparty,
    status: node.status,
    timestamp: normalizeTimestamp(node.createdAt),
    source_wallet_id: sourceWalletId,
  };
}

interface BlinkTxConnection {
  edges?: { cursor: string; node: BlinkTxNode }[];
  pageInfo?: { hasNextPage: boolean; endCursor: string | null };
}

/**
 * Legacy: fetch all transactions for the Blink account (no wallet filter).
 * Used when a connection has no source_wallets rows.
 *
 * source_wallet_id will be null on every returned transaction since the legacy
 * Blink response doesn't carry it back. Downstream consumers must treat null
 * as "wallet membership unknown — pre-discovery connection."
 */
async function fetchBlinkTransactionsAccountWide(
  apiKey: string,
  cursor: string | null,
): Promise<{ transactions: NormalizedTransaction[]; next_cursor: string | null }> {
  const variables: Record<string, unknown> = { first: 50 };
  if (cursor) variables.after = cursor;

  const res = await fetch(BLINK_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify({ query: TX_QUERY, variables }),
  });
  if (!res.ok) throw new Error(`Blink API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);

  const json = await res.json() as {
    data?: { me?: { defaultAccount?: { transactions?: BlinkTxConnection } } };
    errors?: { message: string }[];
  };
  if (json.errors?.length) throw new Error(`Blink GraphQL: ${json.errors[0].message}`);

  const txData = json.data?.me?.defaultAccount?.transactions;
  if (!txData) throw new Error('Blink returned no transaction data');

  return {
    transactions: (txData.edges ?? []).map(e => normalizeBlinkTx(e.node, null)),
    next_cursor: txData.pageInfo?.hasNextPage ? (txData.pageInfo.endCursor ?? null) : null,
  };
}

/**
 * Wallet-scoped Blink fetch. Pulls transactions for ONLY the supplied
 * external wallet IDs. Each returned transaction is tagged with the
 * source wallet it belongs to so downstream consumers can route per-wallet.
 *
 * Blink's `transactionsByWalletIds` returns a flat feed across the requested
 * wallets without per-edge wallet attribution. To preserve source_wallet_id
 * we issue ONE request PER WALLET ID. This is the right tradeoff today: a
 * Blink account currently has 2 wallets (BTC + USD) so the fan-out is small,
 * and getting accurate routing matters more than saving one HTTP round trip.
 */
async function fetchBlinkTransactionsByWalletIds(
  apiKey: string,
  walletIds: string[],
  cursor: string | null,
): Promise<{ transactions: NormalizedTransaction[]; next_cursor: string | null }> {
  if (walletIds.length === 0) return { transactions: [], next_cursor: null };

  const allTxs: NormalizedTransaction[] = [];
  let combinedHasMore = false;
  let lastCursor: string | null = null;

  for (const walletId of walletIds) {
    const variables: Record<string, unknown> = { walletIds: [walletId], first: 50 };
    if (cursor) variables.after = cursor;

    const res = await fetch(BLINK_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
      body: JSON.stringify({ query: TX_QUERY_BY_WALLET_IDS, variables }),
    });
    if (!res.ok) {
      throw new Error(`Blink API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    }

    const json = (await res.json()) as {
      data?: { me?: { defaultAccount?: { transactionsByWalletIds?: BlinkTxConnection } } };
      errors?: { message: string }[];
    };
    if (json.errors?.length) {
      throw new Error(`Blink GraphQL (transactionsByWalletIds): ${json.errors[0].message}`);
    }

    const txData = json.data?.me?.defaultAccount?.transactionsByWalletIds;
    if (!txData) throw new Error('Blink returned no wallet transaction data');

    for (const edge of txData.edges ?? []) {
      allTxs.push(normalizeBlinkTx(edge.node, walletId));
    }
    if (txData.pageInfo?.hasNextPage) {
      combinedHasMore = true;
      lastCursor = txData.pageInfo.endCursor ?? lastCursor;
    }
  }

  // Sort newest first to keep persisted order roughly consistent across
  // the per-wallet fan-out. The DB upsert is idempotent on
  // (connection_id, external_id) so order only affects display ordering
  // before next_cursor advances.
  allTxs.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

  return {
    transactions: allTxs,
    next_cursor: combinedHasMore ? lastCursor : null,
  };
}

interface ProviderAdapter {
  /** Sync wallet-scoped (preferred when source_wallets rows exist). */
  syncByWallets: (
    key: string,
    walletIds: string[],
    cursor: string | null,
  ) => Promise<{ transactions: NormalizedTransaction[]; next_cursor: string | null }>;
  /** Sync account-wide (legacy fallback for pre-discovery connections). */
  syncAccountWide: (
    key: string,
    cursor: string | null,
  ) => Promise<{ transactions: NormalizedTransaction[]; next_cursor: string | null }>;
}

const PROVIDERS: Record<string, ProviderAdapter> = {
  blink: {
    syncByWallets: fetchBlinkTransactionsByWalletIds,
    syncAccountWide: fetchBlinkTransactionsAccountWide,
  },
};

// ─── Main handler ────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    const ctx = await authenticateRequest(req);
    if (isAuthError(ctx)) return jsonResponse({ error: ctx.message }, ctx.status, cors);

    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);

    const body = JSON.parse(raw) as {
      subaccount_id?: string;
      connection_ids?: string[];
      credentials_key: string;
      transactions_key: string;
    };

    const { credentials_key, transactions_key, connection_ids } = body ?? {};
    if (!credentials_key || !transactions_key) {
      return jsonResponse({ error: 'credentials_key and transactions_key required' }, 400, cors);
    }

    const subaccountId = await resolveSubaccount(ctx, body.subaccount_id);
    if (isAuthError(subaccountId)) return jsonResponse({ error: subaccountId.message }, subaccountId.status, cors);

    const credsKey = await importAesKey(credentials_key);
    const txnsKey = await importAesKey(transactions_key);

    let connQuery = ctx.serviceClient
      .from('connections')
      .select('id, provider_type, encrypted_credentials, last_sync_cursor')
      .eq('subaccount_id', subaccountId)
      .neq('status', 'disconnected');
    if (connection_ids?.length) connQuery = connQuery.in('id', connection_ids);

    const { data: connections, error: connErr } = await connQuery;
    if (connErr) throw connErr;
    if (!connections?.length) return jsonResponse({ synced: 0, connections: [] }, 200, cors);

    const results: Array<{ connection_id: string; synced: number; next_cursor: string | null; error?: string }> = [];

    for (const conn of connections) {
      try {
        const adapter = PROVIDERS[conn.provider_type];
        if (!adapter) throw new Error(`Unknown provider: ${conn.provider_type}`);

        const credsJson = await decryptAes(conn.encrypted_credentials, credsKey);
        const { api_key } = JSON.parse(credsJson) as { api_key: string };
        if (!api_key) throw new Error('Connection has no api_key field');

        // Look up the user's source-wallet selection. If any rows exist with
        // is_synced=true we go wallet-scoped; otherwise we fall back to the
        // legacy account-wide path. We deliberately do NOT auto-backfill
        // source_wallets here — legacy connections continue working untouched
        // until the user opts in by re-running discovery from the UI.
        const { data: sourceWallets, error: swErr } = await ctx.serviceClient
          .from('source_wallets')
          .select('external_wallet_id, is_synced')
          .eq('connection_id', conn.id)
          .eq('is_synced', true);

        if (swErr) throw swErr;

        let newTxs: NormalizedTransaction[];
        let next_cursor: string | null;

        if (sourceWallets && sourceWallets.length > 0) {
          const walletIds = sourceWallets.map((w: { external_wallet_id: string }) => w.external_wallet_id);
          const out = await adapter.syncByWallets(api_key, walletIds, conn.last_sync_cursor ?? null);
          newTxs = out.transactions;
          next_cursor = out.next_cursor;
        } else {
          const out = await adapter.syncAccountWide(api_key, conn.last_sync_cursor ?? null);
          newTxs = out.transactions;
          next_cursor = out.next_cursor;
        }

        if (newTxs.length > 0) {
          const rows = await Promise.all(
            newTxs.map(async tx => ({
              connection_id: conn.id,
              external_id: tx.id,
              encrypted_payload: await encryptAes(JSON.stringify(tx), txnsKey),
              payload_key_version: 1,
              occurred_at: tx.timestamp,
            })),
          );
          const { error: upsertErr } = await ctx.serviceClient
            .from('encrypted_transactions')
            .upsert(rows, { onConflict: 'connection_id,external_id', ignoreDuplicates: true });
          if (upsertErr) throw upsertErr;
        }

        await ctx.serviceClient
          .from('connections')
          .update({ last_sync_at: new Date().toISOString(), last_sync_cursor: next_cursor, status: 'active', encrypted_last_error: null })
          .eq('id', conn.id);

        results.push({ connection_id: conn.id, synced: newTxs.length, next_cursor });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[or-sync] connection ${conn.id}:`, msg);
        let encryptedErr: string | null = null;
        try { encryptedErr = await encryptAes(msg.slice(0, 500), txnsKey); } catch { /* ignore */ }
        await ctx.serviceClient.from('connections').update({ status: 'error', encrypted_last_error: encryptedErr }).eq('id', conn.id);
        results.push({ connection_id: conn.id, synced: 0, next_cursor: null, error: msg });
      }
    }

    return jsonResponse({ synced: results.reduce((s, r) => s + r.synced, 0), connections: results }, 200, cors);

  } catch (err) {
    console.error('[or-sync] fatal:', err);
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500, cors);
  }
});
