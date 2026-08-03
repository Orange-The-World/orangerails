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
 *   higher than the supplied value when a concurrent call already advanced it.
 *   The forward-only guarantee is enforced atomically by the UPDATE itself
 *   (conditional WHERE on the row, not application-level read-then-compare).
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

    // Read the row to verify ownership (app_user_id must match the connection owner).
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

    // Fallback value when the conditional UPDATE below is a no-op.
    const storedCursor = (row.last_block_scanned as number | null) ?? -1;

    // Advance the cursor atomically. The UPDATE includes the forward-only
    // condition as a PostgREST filter so the write fires only when the stored
    // value is NULL (never set) or strictly less than the incoming tip.
    // Two concurrent callers carrying different tips cannot both advance the
    // cursor to their own values: the one that arrives second finds stored >=
    // its tip and the UPDATE is a no-op, leaving the cursor at max(both).
    // A read-then-unconditional-write pair cannot give this guarantee because
    // nothing locks the row between the SELECT and the UPDATE: both callers
    // can pass an application-level comparison and the later UPDATE wins
    // regardless of which tip it carries.
    const { data: updatedRow, error: updErr } = await ctx.serviceClient
      .from('stealth_connections')
      .update({
        last_block_scanned: body.last_block_scanned,
        last_sync_at: new Date().toISOString(),
      })
      .eq('platform_id', callerPlatformId)
      .eq('id', body.connection_id)
      .or(`last_block_scanned.lt.${body.last_block_scanned},last_block_scanned.is.null`)
      .select('last_block_scanned')
      .maybeSingle();
    if (updErr) {
      console.error('[or-stealth-envelope-update] update failed:', updErr);
      return jsonResponse({ error: 'Failed to update cursor' }, 500, cors);
    }

    // When 0 rows matched the conditional filter, the stored cursor was already
    // at or above the incoming value. storedCursor (from the SELECT above) is
    // guaranteed to be >= body.last_block_scanned in that case.
    const effectiveCursor = updatedRow !== null ? body.last_block_scanned : storedCursor;

    const resp: EnvelopeUpdateResponseBody = {
      connection_id: body.connection_id,
      last_block_scanned: effectiveCursor,
    };
    return jsonResponse(resp, 200, cors);
  } catch (err) {
    console.error('[or-stealth-envelope-update] fatal:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
}, 'or-stealth-envelope-update'));

export type { EnvelopeUpdateRequestBody, EnvelopeUpdateResponseBody };
