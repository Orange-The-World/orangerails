/**
 * or-connection-list — list a subaccount's connections.
 *
 * Returns encrypted blobs as-is. The caller's browser decrypts with ORK.
 *
 * POST body:
 *   subaccount_id?: uuid  required in platform mode
 *
 * Response:
 *   { connections: [{ id, provider_type, encrypted_label, encrypted_credentials,
 *                     status, last_sync_at, last_sync_cursor, encrypted_last_error,
 *                     credentials_key_version, created_at }] }
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
    const body = JSON.parse(raw || '{}') as { subaccount_id?: string };

    const subaccountId = await resolveSubaccount(ctx, body.subaccount_id);
    if (isAuthError(subaccountId)) return jsonResponse({ error: subaccountId.message }, subaccountId.status, cors);

    const { data: rows, error } = await ctx.serviceClient
      .from('connections')
      .select('id, provider_type, encrypted_label, encrypted_credentials, credentials_key_version, status, last_sync_at, last_sync_cursor, encrypted_last_error, created_at')
      .eq('subaccount_id', subaccountId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[or-connection-list] query failed:', error);
      return jsonResponse({ error: 'Failed to list connections' }, 500, cors);
    }

    return jsonResponse({ connections: rows ?? [] }, 200, cors);
  } catch (err) {
    console.error('[or-connection-list] fatal:', err);
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500, cors);
  }
});
