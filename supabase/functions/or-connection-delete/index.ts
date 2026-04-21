/**
 * or-connection-delete — delete a connection (and its transactions via cascade).
 *
 * POST body:
 *   subaccount_id?: uuid  required in platform mode
 *   connection_id:  uuid  the connection to delete (must belong to subaccount)
 *
 * Response: { ok: true }
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, resolveSubaccount, isAuthError } from '../_shared/platform-auth.ts';

Deno.serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    const ctx = await authenticateRequest(req);
    if (isAuthError(ctx)) return jsonResponse({ error: ctx.message }, ctx.status, cors);

    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);

    const body = JSON.parse(raw) as { subaccount_id?: string; connection_id?: string };
    if (!body.connection_id) return jsonResponse({ error: 'connection_id required' }, 400, cors);

    const subaccountId = await resolveSubaccount(ctx, body.subaccount_id);
    if (isAuthError(subaccountId)) return jsonResponse({ error: subaccountId.message }, subaccountId.status, cors);

    const { error: delErr, count } = await ctx.serviceClient
      .from('connections')
      .delete({ count: 'exact' })
      .eq('id', body.connection_id)
      .eq('subaccount_id', subaccountId);

    if (delErr) {
      console.error('[or-connection-delete] delete failed:', delErr);
      return jsonResponse({ error: 'Failed to delete connection' }, 500, cors);
    }
    if ((count ?? 0) === 0) {
      return jsonResponse({ error: 'Connection not found in this subaccount' }, 404, cors);
    }

    return jsonResponse({ ok: true }, 200, cors);
  } catch (err) {
    console.error('[or-connection-delete] fatal:', err);
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500, cors);
  }
});
