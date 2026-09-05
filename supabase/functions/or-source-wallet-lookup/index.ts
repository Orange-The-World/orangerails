/**
 * or-source-wallet-lookup -- read-only reverse lookup: given a source_wallet id,
 * return the connection that owns it, scoped to the caller's subaccount.
 *
 * BitBooks (and other platforms) receive source_wallet_id values from
 * or-link-complete and or-source-wallets-set, but have no path to resolve
 * which connection a wallet belongs to without fetching all connections via
 * or-connection-list and searching client-side. This endpoint closes that gap
 * for non-bank wallets (DL-1441).
 *
 * Auth: platform mode (X-Platform-API-Key) or direct mode (Supabase JWT).
 *       Widget mode is refused by resolveSubaccount -- widget callers have
 *       no subaccount.
 *
 * POST body:
 *   subaccount_id?:   uuid   required in platform mode
 *   source_wallet_id: uuid   the id column of the source_wallets row
 *
 * Response (200):
 *   { connection: { id, provider_type, status, last_sync_at, created_at } }
 *
 * 404 when source_wallet_id does not exist in this subaccount.
 *   The 404 is indistinguishable from "it belongs to someone else", so a
 *   caller cannot fish for cross-subaccount wallet ownership by observing
 *   the response status.
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, resolveSubaccount, isAuthError } from '../_shared/platform-auth.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(wrapSentryHandler(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    const ctx = await authenticateRequest(req);
    if (isAuthError(ctx)) return jsonResponse({ error: ctx.message }, ctx.status, cors);

    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);

    const body = JSON.parse(raw || '{}') as {
      subaccount_id?: string;
      source_wallet_id?: string;
    };

    if (!body.source_wallet_id || typeof body.source_wallet_id !== 'string') {
      return jsonResponse({ error: 'source_wallet_id required' }, 400, cors);
    }
    if (body.source_wallet_id.length !== 36 || !UUID_RE.test(body.source_wallet_id)) {
      return jsonResponse({ error: 'source_wallet_id must be a UUID' }, 400, cors);
    }

    const subaccountId = await resolveSubaccount(ctx, body.subaccount_id);
    if (isAuthError(subaccountId)) {
      return jsonResponse({ error: subaccountId.message }, subaccountId.status, cors);
    }

    // Step 1: resolve the connection_id for this wallet. Uses service-role
    // so RLS is bypassed; the ownership check is explicit in step 2.
    const { data: wallet, error: walletErr } = await ctx.serviceClient
      .from('source_wallets')
      .select('connection_id')
      .eq('id', body.source_wallet_id)
      .maybeSingle();

    if (walletErr) {
      console.error('[or-source-wallet-lookup] source_wallets query failed:', walletErr);
      return jsonResponse({ error: 'Lookup failed' }, 500, cors);
    }
    if (!wallet) {
      // Do not leak that the id does not exist vs. belongs to another subaccount.
      return jsonResponse({ error: 'Not found' }, 404, cors);
    }

    // Step 2: verify the connection belongs to this subaccount. The
    // subaccount_id filter means a wallet that exists but is owned by a
    // different subaccount also returns 404, not 403. Same shape as
    // or-source-wallets-set's connection ownership check.
    const { data: conn, error: connErr } = await ctx.serviceClient
      .from('connections')
      .select('id, provider_type, status, last_sync_at, created_at')
      .eq('id', wallet.connection_id)
      .eq('subaccount_id', subaccountId)
      .maybeSingle();

    if (connErr) {
      console.error('[or-source-wallet-lookup] connection query failed:', connErr);
      return jsonResponse({ error: 'Lookup failed' }, 500, cors);
    }
    if (!conn) {
      // Wallet exists but the connection is not in this subaccount.
      // Return 404, not 403, to avoid confirming that the wallet id is real.
      return jsonResponse({ error: 'Not found' }, 404, cors);
    }

    return jsonResponse({
      connection: {
        id: conn.id,
        provider_type: conn.provider_type,
        status: conn.status,
        last_sync_at: conn.last_sync_at,
        created_at: conn.created_at,
      },
    }, 200, cors);
  } catch (err) {
    console.error('[or-source-wallet-lookup] fatal:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
}, 'or-source-wallet-lookup'));
