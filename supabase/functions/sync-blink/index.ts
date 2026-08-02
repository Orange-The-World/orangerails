import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0';
import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';

const BLINK_API = 'https://api.blink.sv/graphql';

const TRANSACTIONS_QUERY = `
  query GetTransactions($after: String) {
    me {
      defaultAccount {
        wallets {
          id
          walletCurrency
          balance
          transactions(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id
                direction
                status
                memo
                createdAt
                settlementAmount
                settlementCurrency
                settlementFee
                initiationVia {
                  ... on InitiationViaLn { paymentHash }
                  ... on InitiationViaOnChain { address }
                }
              }
            }
          }
        }
      }
    }
  }
`;

interface BlinkTx {
  id: string;
  direction: string;
  status: string;
  memo: string | null;
  createdAt: number | string;
  settlementAmount: number;
  settlementCurrency?: string;
  settlementFee?: number;
  initiationVia?: { paymentHash?: string; address?: string };
}

interface OrTx {
  id: string;
  adapter: 'blink';
  direction: 'in' | 'out';
  type: 'lightning' | 'onchain';
  amount_sats: number;
  currency: string;
  fee_sats: number;
  description: string | null;
  timestamp: string | number;
  status: string;
  raw: BlinkTx;
}

function normalize(tx: BlinkTx, walletCurrency: string): OrTx {
  const type: 'lightning' | 'onchain' = tx.initiationVia?.paymentHash ? 'lightning' : 'onchain';
  // Blink returns createdAt as a Unix timestamp in SECONDS. Postgres
  // timestamptz requires an ISO 8601 string, so we convert here. If the
  // value is already a string (defensive against future schema change),
  // pass it through.
  const timestamp =
    typeof tx.createdAt === 'number'
      ? new Date(tx.createdAt * 1000).toISOString()
      : typeof tx.createdAt === 'string' && /^\d+$/.test(tx.createdAt)
        ? new Date(Number(tx.createdAt) * 1000).toISOString()
        : tx.createdAt;
  return {
    id: tx.id,
    adapter: 'blink',
    direction: tx.direction === 'RECEIVE' ? 'in' : 'out',
    type,
    amount_sats: Math.abs(tx.settlementAmount),
    currency: tx.settlementCurrency || walletCurrency,
    fee_sats: tx.settlementFee ?? 0,
    description: tx.memo ?? null,
    timestamp,
    status: tx.status,
    raw: tx,
  };
}

async function syncBlink(
  apiKey: string,
  cursor: string | null,
): Promise<{ transactions: OrTx[]; next_cursor: string | null }> {
  const res = await fetch(BLINK_API, {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: TRANSACTIONS_QUERY, variables: { after: cursor || null } }),
  });
  if (!res.ok) throw new Error(`Blink HTTP ${res.status}`);
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0].message);

  const wallets = data.data.me.defaultAccount.wallets;
  const transactions: OrTx[] = [];
  let nextCursor: string | null = null;
  for (const wallet of wallets) {
    const { edges, pageInfo } = wallet.transactions;
    if (pageInfo.hasNextPage) nextCursor = pageInfo.endCursor;
    for (const { node: tx } of edges) {
      transactions.push(normalize(tx, wallet.walletCurrency));
    }
  }
  return { transactions, next_cursor: nextCursor };
}

Deno.serve(wrapSentryHandler(async (req: Request) => {
  const cors = buildCorsHeaders(req);

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return jsonResponse({ error: 'Missing Authorization header' }, 401, cors);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return jsonResponse({ error: 'Unauthorized' }, 401, cors);

    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);

    const body = JSON.parse(raw);
    const { api_key, cursor } = body ?? {};
    if (!api_key || typeof api_key !== 'string') return jsonResponse({ error: 'api_key required' }, 400, cors);

    const result = await syncBlink(api_key, cursor ?? null);
    return jsonResponse(result, 200, cors);
  } catch (err) {
    // Log the full error server-side for diagnostics, but never echo upstream
    // response bodies (or err.message which may include them) to the client.
    // Defense-in-depth: if a provider's error response ever contains the
    // api_key or request echo, the client must not see it.
    console.error('sync-blink error:', err);
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('Blink HTTP')) {
      return jsonResponse({ error: 'Blink sync failed' }, 502, cors);
    }
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
}, 'sync-blink'));
