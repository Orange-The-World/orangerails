/**
 * or-stealth-envelope-update -- advance the scan-tip cursor for a stealth connection.
 *
 * Master plan: STEALTH-SYNC-MASTER-PLAN.md section 4.6.
 *
 * Called by the widget in step 4 of the sync flow (sync.tsx lines 286-337),
 * after or-stealth-transactions-store has stored any new sealed transactions.
 * or-stealth-transactions-store advances last_block_scanned only to the max
 * block_height of rows it actually committed; this function advances it to the
 * true scan tip (the chain tip at the time runSync finished), so syncs that
 * found zero matching transactions still move the window forward and the next
 * sync does not rescan the same range.
 *
 * POST body:
 *   connection_id:      string (uuid)
 *   app_user_id:        string
 *   last_block_scanned: number (non-negative integer, the scan tip)
 *
 * Response:
 *   { connection_id, last_block_scanned }
 *   last_block_scanned reflects the stored cursor after the call. It may be
 *   higher than the supplied value when a concurrent call already advanced it;
 *   it is never lower (forward-only guard).
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import {
  authenticateRequest,
  isAuthError,
  getCallerPlatformId,
} from '../_shared/platform-auth.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';

interface EnvelopeUpdateRequestBody {
  connection_id?: string;
  app_user_id?: string;
  last_block_scanned?: number;
}

interface EnvelopeUpdateResponseBody {
  connection_id: string;
  last_block_scanned: number;
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
    const body = JSON.parse(raw || '{}') as EnvelopeUpdateRequestBody;

    if (!body.connection_id || !UUID_RE.test(body.connection_id)) {
      return jsonResponse({ error: 'connection_id (uuid) required' }, 400, cors);
    }
    if (!body.app_user_id || typeof body.app_user_id !== 'string') {
      return jsonResponse({ error: 'app_user_id required' }, 400, cors);
    }
    if (
      body.last_block_scanned === undefined ||
      typeof body.last_block_scanned !== 'number' ||
      !Number.isInteger(body.last_block_scanned) ||
      body.last_block_scanned < 0
    ) {
      return jsonResponse(
        { error: 'last_block_scanned must be a non-negative integer' },
        400,
        cors,
      );
    }

    // Direct mode: the authenticated user must own this connection.
    // Platform mode: trust the caller's app_user_id (platform has its own
    // mapping back to its end users; we just route by it).
    if (ctx.mode === 'direct' && body.app_user_id !== ctx.userId) {
      return jsonResponse(
        { error: 'app_user_id must match the authenticated user' },
        403,
        cors,
      );
    }

    // Audit 2026-05-16 High #2: every stealth_connections read/write must be
    // bound to the calling platform. Resolve once here.
    const platformIdOrErr = await getCallerPlatformId(ctx);
    if (isAuthError(platformIdOrErr)) {
      return jsonResponse({ error: platformIdOrErr.message }, platformIdOrErr.status, cors);
    }
    const callerPlatformId = platformIdOrErr;

    // Read the current cursor so we can apply the forward-only guard.
    // Two round trips (read then conditional write) keeps the logic
    // transparent and auditable without a stored procedure.
    const { data: row, error: selErr } = await ctx.serviceClient
      .from('stealth_connections')
      .select('id, app_user_id, last_block_scanned')
      .eq('platform_id', callerPlatformId)
      .eq('id', body.connection_id)
      .maybeSingle();
    if (selErr) {
      console.error('[or-stealth-envelope-update] select failed:', selErr);
      return jsonResponse({ error: 'Failed to load stealth connection' }, 500, cors);
    }
    if (!row) {
      return jsonResponse({ error: 'Connection not found' }, 404, cors);
    }
    if ((row.app_user_id as string) !== body.app_user_id) {
      return jsonResponse({ error: 'Connection does not belong to caller' }, 403, cors);
    }

    const storedCursor = (row.last_block_scanned as number | null) ?? -1;

    // Forward-only guard: never move the cursor backwards. Return the current
    // stored value without touching the row. Concurrent calls that race to
    // write the same tip are both safe: the first one lands, the second is a
    // no-op here (equal, not greater-than).
    if (body.last_block_scanned <= storedCursor) {
      const resp: EnvelopeUpdateResponseBody = {
        connection_id: body.connection_id,
        last_block_scanned: storedCursor,
      };
      return jsonResponse(resp, 200, cors);
    }

    const { error: updErr } = await ctx.serviceClient
      .from('stealth_connections')
      .update({
        last_block_scanned: body.last_block_scanned,
        last_sync_at: new Date().toISOString(),
      })
      .eq('platform_id', callerPlatformId)
      .eq('id', body.connection_id);
    if (updErr) {
      console.error('[or-stealth-envelope-update] update failed:', updErr);
      return jsonResponse({ error: 'Failed to update cursor' }, 500, cors);
    }

    const resp: EnvelopeUpdateResponseBody = {
      connection_id: body.connection_id,
      last_block_scanned: body.last_block_scanned,
    };
    return jsonResponse(resp, 200, cors);
  } catch (err) {
    console.error('[or-stealth-envelope-update] fatal:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
}, 'or-stealth-envelope-update'));

export type { EnvelopeUpdateRequestBody, EnvelopeUpdateResponseBody };
