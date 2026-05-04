/**
 * or-stealth-connection-list — list a user's sealed connections.
 *
 * Milestone 1 stub. Full behavior in STEALTH-SYNC-MASTER-PLAN.md §6.1.
 *
 * Returns sealed envelopes as-is. The widget popup decrypts them in the
 * browser using the per-app stealth key it received over postMessage.
 *
 * POST body:
 *   app_slug:     string
 *   app_user_id:  string (uuid)
 *
 * Response:
 *   { connections: Array<{
 *       id, app_slug, connection_kind, sealed_envelope,
 *       wallet_birthday_plaintext, status, last_sync_at,
 *       last_block_scanned, created_at, updated_at,
 *       tx_count
 *     }> }
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, isAuthError } from '../_shared/platform-auth.ts';

interface ListRequestBody {
  app_slug?: string;
  app_user_id?: string;
}

interface StealthConnectionRow {
  id: string;
  app_slug: string;
  connection_kind: 'xpub_stealth' | 'descriptor_stealth';
  sealed_envelope: unknown;
  wallet_birthday_plaintext: string | null;
  status: 'active' | 'error' | 'archived';
  last_sync_at: string | null;
  last_block_scanned: number | null;
  created_at: string;
  updated_at: string;
  tx_count: number;
}

interface ListResponseBody {
  connections: StealthConnectionRow[];
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
    const body = JSON.parse(raw || '{}') as ListRequestBody;

    // TODO(milestone-1): validate body, fetch rows scoped to (app_slug, app_user_id),
    // join with stealth_transactions count, return ListResponseBody.
    void body;
    void ctx;

    return jsonResponse(
      { error: 'or-stealth-connection-list not yet implemented' },
      501,
      cors,
    );
  } catch (err) {
    console.error('[or-stealth-connection-list] fatal:', err);
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500, cors);
  }
});

export type { ListRequestBody, ListResponseBody, StealthConnectionRow };
