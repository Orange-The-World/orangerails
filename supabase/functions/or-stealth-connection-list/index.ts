/**
 * or-stealth-connection-list , list a user's sealed connections.
 *
 * Master plan: STEALTH-SYNC-MASTER-PLAN.md §6.1.
 *
 * Returns lightweight metadata for each connection. The widget popup
 * decrypts envelope contents only when it actually needs them (e.g. for
 * an active sync); the picker view uses the plaintext columns we already
 * keep in the clear (created_at, last_sync_at, status, etc.).
 *
 * POST body:
 *   app_user_id:  string (uuid, required)
 *   app_slug:     string (optional defense-in-depth filter)
 *
 * Response:
 *   { connections: Array<{
 *       connection_id, app_slug, connection_kind, last_sync_at,
 *       last_block_scanned, status, created_at
 *     }> }
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, isAuthError, getCallerPlatformId } from '../_shared/platform-auth.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';

interface ListRequestBody {
  app_user_id?: string;
  app_slug?: string;
}

interface ListedConnection {
  connection_id: string;
  app_slug: string;
  connection_kind: 'xpub_stealth' | 'descriptor_stealth';
  last_sync_at: string | null;
  last_block_scanned: number | null;
  status: 'active' | 'error' | 'archived';
  created_at: string;
}

interface ListResponseBody {
  connections: ListedConnection[];
}

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
    const body = JSON.parse(raw || '{}') as ListRequestBody;

    if (!body.app_user_id || typeof body.app_user_id !== 'string' || !UUID_RE.test(body.app_user_id)) {
      return jsonResponse({ error: 'app_user_id (uuid) required' }, 400, cors);
    }
    if (body.app_slug !== undefined && typeof body.app_slug !== 'string') {
      return jsonResponse({ error: 'app_slug must be a string when provided' }, 400, cors);
    }

    if (ctx.mode === 'direct' && body.app_user_id !== ctx.userId) {
      return jsonResponse(
        { error: 'app_user_id must match the authenticated user' },
        403, cors,
      );
    }

    // Audit 2026-05-16 High #2: every stealth_connections read/write must be
    // bound to the calling platform. Resolve once here.
    const platformIdOrErr = await getCallerPlatformId(ctx);
    if (isAuthError(platformIdOrErr)) {
      return jsonResponse({ error: platformIdOrErr.message }, platformIdOrErr.status, cors);
    }
    const callerPlatformId = platformIdOrErr;

    let query = ctx.serviceClient
      .from('stealth_connections')
      .select('id, app_slug, connection_kind, last_sync_at, last_block_scanned, status, created_at')
      .eq('platform_id', callerPlatformId)
      .eq('app_user_id', body.app_user_id)
      .order('created_at', { ascending: false });
    if (body.app_slug) {
      query = query.eq('app_slug', body.app_slug);
    }

    const { data: rows, error: selErr } = await query;
    if (selErr) {
      console.error('[or-stealth-connection-list] select failed:', selErr);
      return jsonResponse({ error: 'Failed to list stealth connections' }, 500, cors);
    }

    const connections: ListedConnection[] = (rows ?? []).map((r) => ({
      connection_id: r.id as string,
      app_slug: r.app_slug as string,
      connection_kind: r.connection_kind as 'xpub_stealth' | 'descriptor_stealth',
      last_sync_at: (r.last_sync_at as string | null) ?? null,
      last_block_scanned: (r.last_block_scanned as number | null) ?? null,
      status: r.status as 'active' | 'error' | 'archived',
      created_at: r.created_at as string,
    }));

    const resp: ListResponseBody = { connections };
    return jsonResponse(resp, 200, cors);
  } catch (err) {
    console.error('[or-stealth-connection-list] fatal:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
}, 'or-stealth-connection-list'));

export type { ListRequestBody, ListResponseBody, ListedConnection };
