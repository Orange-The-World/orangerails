/**
 * Blink source adapter (Galoy's consumer Lightning wallet).
 *
 * Reference implementation that proved the source-adapter pattern (see
 * OrangeRails-Protocol.html §15). Uses Blink's GraphQL API at
 * https://api.blink.sv/graphql with an X-API-KEY header.
 *
 * Wallets-per-account: Blink ships every account with two wallets — a BTC
 * Lightning wallet (settlementCurrency=BTC, sats) and a USD wallet
 * (settlementCurrency=USD, cents). The user picks which to sync via the
 * source_wallets table; this adapter filters server-side via the
 * wallet-scoped GraphQL query.
 *
 * Cursor: Blink's `transactions(first, after)` connection returns an opaque
 * cursor string per edge. We persist the most recent endCursor; on next
 * sync we pass it as `after`. For the wallet-scoped path the cursor is a
 * placeholder until we move to a per-wallet cursor map (see fetch fn below).
 */

import type {
  ProviderAdapter,
  DiscoveredWallet,
  NormalizedTransaction,
  SyncResult,
} from './types.ts';

const BLINK_API = 'https://api.blink.sv/graphql';
const PAGE_SIZE = 50;

// ─── GraphQL queries ─────────────────────────────────────────────────────

const DISCOVER_QUERY = `
  query DiscoverWallets {
    me {
      defaultAccount {
        wallets {
          id
          walletCurrency
        }
      }
    }
  }
`;

// Account-wide query — used when a connection has no source_wallets rows
// (existing connections from before the per-wallet feature shipped).
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

// Wallet-scoped query.
//
// Blink's `me.defaultAccount` returns the abstract `Account` interface, which
// does NOT expose `transactionsByWalletIds` (an earlier draft assumed it did
// and the live schema rejected the query at runtime).
//
// The schema instead exposes a `transactions(first, after)` connection on
// each `Wallet` directly. We fetch every wallet under the account in a
// single round trip and filter client-side to the user's selected wallet IDs.
const TX_QUERY_BY_WALLETS = `
  query TxnsByWallets($first: Int!, $after: String) {
    me {
      defaultAccount {
        wallets {
          id
          walletCurrency
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
  }
`;

// ─── Types ───────────────────────────────────────────────────────────────

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

interface BlinkTxConnection {
  edges?: { cursor: string; node: BlinkTxNode }[];
  pageInfo?: { hasNextPage: boolean; endCursor: string | null };
}

interface BlinkWalletNode {
  id: string;
  walletCurrency: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function getApiKey(credentials: Record<string, unknown>): string {
  const k = credentials.api_key;
  if (typeof k !== 'string' || !k) throw new Error('[blink] credentials.api_key missing');
  return k;
}

async function blinkPost<T>(apiKey: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(BLINK_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Blink API ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = await res.json() as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(`Blink GraphQL: ${json.errors[0].message}`);
  if (!json.data) throw new Error('Blink returned no data');
  return json.data;
}

function normalizeTimestamp(v: string | number): string {
  if (typeof v === 'number') return new Date(v >= 1e12 ? v : v * 1000).toISOString();
  if (/^\d+$/.test(String(v))) {
    const n = Number(v);
    return new Date(n >= 1e12 ? n : n * 1000).toISOString();
  }
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
    ...(isBtc
      ? { amount_sats: Math.abs(node.settlementAmount) }
      : { amount: Math.abs(node.settlementAmount / 100), currency: 'USD' }),
    description: node.memo ?? null,
    counterparty,
    status: node.status,
    timestamp: normalizeTimestamp(node.createdAt),
    source_wallet_id: sourceWalletId,
  };
}

// ─── Adapter implementation ──────────────────────────────────────────────

async function discover(credentials: Record<string, unknown>): Promise<DiscoveredWallet[]> {
  const apiKey = getApiKey(credentials);
  const data = await blinkPost<{ me?: { defaultAccount?: { wallets?: BlinkWalletNode[] } } }>(
    apiKey,
    DISCOVER_QUERY,
  );
  const wallets = data.me?.defaultAccount?.wallets;
  if (!Array.isArray(wallets)) throw new Error('Blink returned no wallet data');
  return wallets.map(w => ({
    external_wallet_id: w.id,
    currency: w.walletCurrency, // 'BTC' or 'USD'
  }));
}

async function syncAccountWide(
  credentials: Record<string, unknown>,
  cursor: string | null,
): Promise<SyncResult> {
  const apiKey = getApiKey(credentials);
  const variables: Record<string, unknown> = { first: PAGE_SIZE };
  if (cursor) variables.after = cursor;

  const data = await blinkPost<{ me?: { defaultAccount?: { transactions?: BlinkTxConnection } } }>(
    apiKey,
    TX_QUERY,
    variables,
  );
  const txData = data.me?.defaultAccount?.transactions;
  if (!txData) throw new Error('Blink returned no transaction data');
  return {
    transactions: (txData.edges ?? []).map(e => normalizeBlinkTx(e.node, null)),
    next_cursor: txData.pageInfo?.hasNextPage ? (txData.pageInfo.endCursor ?? null) : null,
  };
}

/**
 * Wallet-scoped Blink fetch. ONE GraphQL request returns every wallet on
 * the account with each wallet's `transactions` connection inlined; we
 * drop wallets the user didn't select and tag each kept transaction with
 * its wallet's id.
 *
 * Pagination: each wallet has its own cursor. For the first iteration we
 * request `first: PAGE_SIZE` per wallet without `after` and let the next
 * sync cycle pick up anything older — fine for small accounts (Blink ships
 * 2 wallets per account) and avoids carrying a per-wallet cursor map
 * through `connections.last_sync_cursor`. We surface the largest endCursor
 * so the connection still records progress, but the legacy single-cursor
 * format doesn't actually drive per-wallet pagination yet.
 */
async function syncByWallets(
  credentials: Record<string, unknown>,
  walletIds: string[],
  cursor: string | null,
): Promise<SyncResult> {
  if (walletIds.length === 0) return { transactions: [], next_cursor: null };

  const apiKey = getApiKey(credentials);
  const variables: Record<string, unknown> = { first: PAGE_SIZE };
  if (cursor) variables.after = cursor;

  const data = await blinkPost<{
    me?: {
      defaultAccount?: {
        wallets?: Array<{ id: string; walletCurrency: string; transactions?: BlinkTxConnection }>;
      };
    };
  }>(apiKey, TX_QUERY_BY_WALLETS, variables);

  const wallets = data.me?.defaultAccount?.wallets;
  if (!wallets) throw new Error('Blink returned no wallets data');

  const selectedSet = new Set(walletIds);
  const allTxs: NormalizedTransaction[] = [];
  let combinedHasMore = false;
  let lastCursor: string | null = null;

  for (const wallet of wallets) {
    if (!selectedSet.has(wallet.id)) continue;
    const txConn = wallet.transactions;
    if (!txConn) continue;
    for (const edge of txConn.edges ?? []) {
      allTxs.push(normalizeBlinkTx(edge.node, wallet.id));
    }
    if (txConn.pageInfo?.hasNextPage) {
      combinedHasMore = true;
      if (txConn.pageInfo.endCursor) lastCursor = txConn.pageInfo.endCursor;
    }
  }

  // Sort newest first to keep persisted order roughly consistent across the
  // per-wallet flatten. The DB upsert is idempotent on
  // (connection_id, external_id) so order only affects display ordering
  // before next_cursor advances.
  allTxs.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

  return {
    transactions: allTxs,
    next_cursor: combinedHasMore ? lastCursor : null,
  };
}

export const blinkAdapter: ProviderAdapter = {
  slug: 'blink',
  displayName: 'Blink',
  multiWallet: true,
  credentialFields: [
    {
      name: 'api_key',
      type: 'secret',
      label: 'Blink API key',
      placeholder: 'blink_…',
    },
  ],
  discoverWallets: discover,
  syncByWallets,
  syncAccountWide,
};
