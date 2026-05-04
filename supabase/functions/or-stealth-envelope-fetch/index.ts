/**
 * or-stealth-envelope-fetch — return a SealedEnvelope by connection_id.
 *
 * Milestone 1 stub. Full behavior in STEALTH-SYNC-MASTER-PLAN.md §4.6.
 *
 * The widget popup calls this at the start of a sync to retrieve the
 * sealed xpub envelope, which it then decrypts in the user's browser.
 *
 * POST body:
 *   connection_id: string (uuid)
 *   app_user_id:   string (uuid)
 *
 * Response:
 *   { connection_id, sealed_envelope, connection_kind,
 *     wallet_birthday_plaintext, last_block_scanned, last_sync_at, status }
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, isAuthError } from '../_shared/platform-auth.ts';

interface EnvelopeFetchRequestBody {
  connection_id?: string;
  app_user_id?: string;
}

interface EnvelopeFetchResponseBody {
  connection_id: string;
  sealed_envelope: unknown;
  connection_kind: 'xpub_stealth' | 'descriptor_stealth';
  wallet_birthday_plaintext: string | null;
  last_block_scanned: number | null;
  last_sync_at: string | null;
  status: 'active' | 'error' | 'archived';
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
    const body = JSON.parse(raw || '{}') as EnvelopeFetchRequestBody;

    // TODO(milestone-1): authorize, look up the connection row, return the
    // sealed_envelope along with the plaintext metadata fields.
    void body;
    void ctx;

    return jsonResponse(
      { error: 'or-stealth-envelope-fetch not yet implemented' },
      501,
      cors,
    );
  } catch (err) {
    console.error('[or-stealth-envelope-fetch] fatal:', err);
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500, cors);
  }
});

export type { EnvelopeFetchRequestBody, EnvelopeFetchResponseBody };
