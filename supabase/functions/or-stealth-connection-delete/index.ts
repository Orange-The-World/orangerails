/**
 * or-stealth-connection-delete — delete a sealed connection + its sealed transactions.
 *
 * Milestone 1 stub. Full behavior in STEALTH-SYNC-MASTER-PLAN.md §6.1.
 *
 * The DB schema cascades stealth_transactions on stealth_connections delete,
 * so deleting the connection row is sufficient. The edge function's job is to
 * authorize the caller and execute the delete.
 *
 * POST body:
 *   connection_id: string (uuid)
 *   app_user_id:   string (uuid)   used by RLS / scoped lookup
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

    // TODO(milestone-1): validate connection_id + app_user_id, delete the
    // matching stealth_connections row (cascade handles transactions),
    // return DeleteResponseBody.
    void body;
    void ctx;

    return jsonResponse(
      { error: 'or-stealth-connection-delete not yet implemented' },
      501,
      cors,
    );
  } catch (err) {
    console.error('[or-stealth-connection-delete] fatal:', err);
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500, cors);
  }
});

export type { DeleteRequestBody, DeleteResponseBody };
