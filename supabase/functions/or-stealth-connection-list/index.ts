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
 *   app_user_id:  string (required)
 *   app_slug:     string (optional defense-in-depth filter)
 *
 * Response:
 *   { connections: Array<{
 *       connection_id, app_slug, connection_kind, last_sync_at,
 *       last_block_scanned, status, created_at,
 *       sync_freshness, hours_since_sync, stale_after_hours
 *     }> }
 *
 * DL-1737, the last three. `sync_freshness` is `never`, `fresh` or `stale`.
 * `hours_since_sync` is the age of `last_sync_at` in hours, or null when there
 * is no usable stamp. `stale_after_hours` is the threshold this response was
 * computed against, returned so no client hardcodes it and so it can be tuned
 * without a client release.
 *
 * `status` is deliberately unchanged and gains no new value: consumers switch
 * on it, so this is strictly additive.
 *
 * The rule and the number come from ../_shared/sync-freshness.ts, the same
 * module or-connection-list uses, so the two read surfaces cannot drift into
 * disagreeing about whether one connection is stale.
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, isAuthError, getCallerPlatformId } from '../_shared/platform-auth.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';
import { computeSyncFreshness } from '../_shared/sync-freshness.ts';
import type { SyncFreshnessFields } from '../_shared/sync-freshness.ts';

interface ListRequestBody {
  app_user_id?: string;
  app_slug?: string;
}

interface ListedConnection extends SyncFreshnessFields {
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

/**
 * Project one `stealth_connections` row into the response shape.
 *
 * Exported and pure so a test can exercise the real mapping instead of a
 * reimplementation of it. A test that rebuilds the projection agrees with its
 * own copy of any bug and proves nothing about what the endpoint returns.
 *
 * `status` is passed through verbatim. Nothing here reads it and the freshness
 * fields never influence it: consumers switch on `status`, so DL-1737 is
 * strictly additive.
 */
export function toListedConnection(
  row: Record<string, unknown>,
  now: Date,
): ListedConnection {
  const lastSyncAt = (row.last_sync_at as string | null) ?? null;
  return {
    connection_id: row.id as string,
    app_slug: row.app_slug as string,
    connection_kind: row.connection_kind as 'xpub_stealth' | 'descriptor_stealth',
    last_sync_at: lastSyncAt,
    last_block_scanned: (row.last_block_scanned as number | null) ?? null,
    status: row.status as 'active' | 'error' | 'archived',
    created_at: row.created_at as string,
    ...computeSyncFreshness(lastSyncAt, now),
  };
}

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

    if (!body.app_user_id || typeof body.app_user_id !== 'string') {
      return jsonResponse({ error: 'app_user_id required' }, 400, cors);
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

    // DL-1737: the clock is read ONCE for the whole response. Read per row,
    // two connections stamped at the same moment could land on opposite sides
    // of the staleness threshold inside the same payload.
    const now = new Date();
    const connections: ListedConnection[] = (rows ?? []).map((r) =>
      toListedConnection(r as Record<string, unknown>, now),
    );

    const resp: ListResponseBody = { connections };
    return jsonResponse(resp, 200, cors);
  } catch (err) {
    console.error('[or-stealth-connection-list] fatal:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
}, 'or-stealth-connection-list'));

export type { ListRequestBody, ListResponseBody, ListedConnection };
