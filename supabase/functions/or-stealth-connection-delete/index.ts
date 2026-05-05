/**
 * or-stealth-connection-delete — delete a sealed connection + its sealed transactions.
 *
 * Master plan: STEALTH-SYNC-MASTER-PLAN.md §6.1.
 *
 * The DB schema cascades stealth_transactions on stealth_connections delete,
 * so deleting the connection row is sufficient.
 *
 * POST body:
 *   connection_id: string (uuid)
 *   app_user_id:   string (uuid)
 *
 * Response:
 *   { connection_id: string, deleted: true }
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, isAuthError } from '../_shared/platform-auth.ts';

interface DeleteRequestBody {
  connection_id?: string;
  app_user_id?: string;
}

interface DeleteResponseBody {
  connection_id: string;
  deleted: true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    const ctx = await authenticateRequest(req);
    if (isAuthError(ctx)) return jsonResponse({ error: ctx.message }, ctx.status, cors);

    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);
    const body = JSON.parse(raw || '{}') as DeleteRequestBody;

    if (!body.connection_id || !UUID_RE.test(body.connection_id)) {
      return jsonResponse({ error: 'connection_id (uuid) required' }, 400, cors);
    }
    if (!body.app_user_id || typeof body.app_user_id !== 'string' || !UUID_RE.test(body.app_user_id)) {
      return jsonResponse({ error: 'app_user_id (uuid) required' }, 400, cors);
    }
    if (ctx.mode === 'direct' && body.app_user_id !== ctx.userId) {
      return jsonResponse(
        { error: 'app_user_id must match the authenticated user' },
        403, cors,
      );
    }

    const { data: deleted, error: delErr } = await ctx.serviceClient
      .from('stealth_connections')
      .delete()
      .eq('id', body.connection_id)
      .eq('app_user_id', body.app_user_id)
      .select('id')
      .maybeSingle();

    if (delErr) {
      console.error('[or-stealth-connection-delete] delete failed:', delErr);
      return jsonResponse({ error: 'Failed to delete stealth connection' }, 500, cors);
    }
    if (!deleted) {
      return jsonResponse({ error: 'Connection not found' }, 404, cors);
    }

    const resp: DeleteResponseBody = {
      connection_id: deleted.id as string,
      deleted: true,
    };
    return jsonResponse(resp, 200, cors);
  } catch (err) {
    console.error('[or-stealth-connection-delete] fatal:', err);
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500, cors);
  }
});

export type { DeleteRequestBody, DeleteResponseBody };
