/**
 * or-transactions-list — list encrypted transactions for a subaccount.
 *
 * Returns encrypted blobs as-is. The caller's browser decrypts with ORT.
 *
 * POST body:
 *   subaccount_id?: uuid       required in platform mode
 *   limit?:         number     default 50, max 200
 *   before?:        timestamptz cursor for pagination (occurred_at < before)
 *
 * Response:
 *   { transactions: [{ id, connection_id, external_id, encrypted_payload, occurred_at }] }
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, resolveSubaccount, isAuthError } from '../_shared/platform-auth.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

Deno.serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    const ctx = await authenticateRequest(req);
    if (isAuthError(ctx)) return jsonResponse({ error: ctx.message }, ctx.status, cors);

    const raw = await readBoundedText(req);
    const body = JSON.parse(raw || '{}') as { subaccount_id?: string; limit?: number; before?: string };

    const subaccountId = await resolveSubaccount(ctx, body.subaccount_id);
    if (isAuthError(subaccountId)) return jsonResponse({ error: subaccountId.message }, subaccountId.status, cors);

    const limit = Math.min(Math.max(1, body.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

    // Find connection IDs belonging to this subaccount, then list their transactions.
    const { data: conns } = await ctx.serviceClient
      .from('connections')
      .select('id')
      .eq('subaccount_id', subaccountId);
    const connIds = (conns ?? []).map(c => c.id as string);
    if (connIds.length === 0) return jsonResponse({ transactions: [] }, 200, cors);

    let q = ctx.serviceClient
      .from('encrypted_transactions')
      .select('id, connection_id, external_id, encrypted_payload, occurred_at')
      .in('connection_id', connIds)
      .order('occurred_at', { ascending: false })
      .limit(limit);
    if (body.before) q = q.lt('occurred_at', body.before);

    const { data: rows, error } = await q;
    if (error) {
      console.error('[or-transactions-list] query failed:', error);
      return jsonResponse({ error: 'Failed to list transactions' }, 500, cors);
    }

    return jsonResponse({ transactions: rows ?? [] }, 200, cors);
  } catch (err) {
    console.error('[or-transactions-list] fatal:', err);
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500, cors);
  }
});
