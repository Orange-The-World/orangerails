/**
 * or-stealth-envelope-fetch , return a SealedEnvelope by connection_id.
 *
 * Master plan: STEALTH-SYNC-MASTER-PLAN.md §4.6.
 *
 * The widget popup calls this at the start of a sync to retrieve the
 * sealed xpub envelope, which it then decrypts in the user's browser.
 *
 * POST body:
 *   connection_id: string (uuid)
 *   app_user_id:   string (uuid)
 *   app_slug:      string (optional, used as defense-in-depth filter)
 *
 * Response:
 *   { connection_id, sealed_envelope, connection_kind,
 *     wallet_birthday_plaintext, last_block_scanned, last_sync_at, status }
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, isAuthError, getCallerPlatformId } from '../_shared/platform-auth.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';

interface EnvelopeFetchRequestBody {
  connection_id?: string;
  app_user_id?: string;
  app_slug?: string;
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
    const body = JSON.parse(raw || '{}') as EnvelopeFetchRequestBody;

    if (!body.connection_id || !UUID_RE.test(body.connection_id)) {
      return jsonResponse({ error: 'connection_id (uuid) required' }, 400, cors);
    }
    if (!body.app_user_id || typeof body.app_user_id !== 'string') {
      return jsonResponse({ error: 'app_user_id required' }, 400, cors);
    }

    // Direct mode: the authenticated user must own this connection.
    // Platform mode: trust the caller's app_user_id (platform has its own
    // mapping back to its end users; we just route by it).
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
      .select(
        'id, app_slug, connection_kind, sealed_envelope, wallet_birthday_plaintext, last_block_scanned, last_sync_at, status, app_user_id',
      )
      .eq('platform_id', callerPlatformId)
      .eq('id', body.connection_id)
      .eq('app_user_id', body.app_user_id);
    if (body.app_slug) {
      query = query.eq('app_slug', body.app_slug);
    }
    const { data: row, error: selErr } = await query.maybeSingle();

    if (selErr) {
      console.error('[or-stealth-envelope-fetch] select failed:', selErr);
      return jsonResponse({ error: 'Failed to load stealth connection' }, 500, cors);
    }
    if (!row) {
      return jsonResponse({ error: 'Connection not found' }, 404, cors);
    }

    const resp: EnvelopeFetchResponseBody = {
      connection_id: row.id as string,
      sealed_envelope: row.sealed_envelope,
      connection_kind: row.connection_kind as 'xpub_stealth' | 'descriptor_stealth',
      wallet_birthday_plaintext: (row.wallet_birthday_plaintext as string | null) ?? null,
      last_block_scanned: (row.last_block_scanned as number | null) ?? null,
      last_sync_at: (row.last_sync_at as string | null) ?? null,
      status: row.status as 'active' | 'error' | 'archived',
    };
    return jsonResponse(resp, 200, cors);
  } catch (err) {
    console.error('[or-stealth-envelope-fetch] fatal:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
}, 'or-stealth-envelope-fetch'));

export type { EnvelopeFetchRequestBody, EnvelopeFetchResponseBody };
