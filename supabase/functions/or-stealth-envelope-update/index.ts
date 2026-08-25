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
  authenticateRequestOrWidgetToken,
  enforceWidgetAppUser,
  isAuthError,
  getCallerPlatformId,
} from '../_shared/platform-auth.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';
import { advanceCursor, isAdvanceCursorError } from './cursor.ts';

interface EnvelopeUpdateRequestBody {
  connection_id?: string;
  app_user_id?: string;
  last_block_scanned?: number;
  /**
   * Inclusive start of the block range just scanned. When present alongside
   * last_block_scanned (the to_height), the handler calls
   * record_stealth_scan_range() to persist the interval. Optional: callers
   * that omit it skip range recording and fall back to the cursor only.
   * DL-1478.
   */
  from_height?: number;
  /**
   * Widget-mode credential. Present when the caller is browser code inside a
   * host app's connect session and holds neither a platform API key nor an
   * OrangeRails JWT. Ignored when X-Platform-API-Key is present.
   */
  widget_token?: string;
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
    // The body is read BEFORE auth because a widget-mode caller presents its
    // credential in the body rather than in a header. Header-based callers are
    // resolved exactly as before; see authenticateRequestOrWidgetToken.
    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);

    // Parsing now happens before authentication, so malformed JSON from an
    // unauthenticated caller must answer 400 rather than fall through to the
    // catch below and answer 500.
    let body: EnvelopeUpdateRequestBody;
    try {
      body = JSON.parse(raw || '{}') as EnvelopeUpdateRequestBody;
    } catch {
      return jsonResponse({ error: 'Request body is not valid JSON' }, 400, cors);
    }

    const ctx = await authenticateRequestOrWidgetToken(req, body.widget_token);
    if (isAuthError(ctx)) return jsonResponse({ error: ctx.message }, ctx.status, cors);

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

    // Widget mode gets the same lock for the same reason: the token pins one
    // app_user_id, so a body naming a different one is an attempt to reach
    // into another user's records.
    const widgetUserErr = enforceWidgetAppUser(ctx, body.app_user_id);
    if (widgetUserErr) {
      return jsonResponse({ error: widgetUserErr.message }, widgetUserErr.status, cors);
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

    const cursorResult = await advanceCursor(
      ctx.serviceClient,
      callerPlatformId,
      body.connection_id,
      body.last_block_scanned,
    );
    if (isAdvanceCursorError(cursorResult)) {
      return jsonResponse({ error: cursorResult.error }, cursorResult.status, cors);
    }
    const effectiveCursor = cursorResult.effectiveCursor;

    // Record the scan range when the caller supplies from_height (DL-1478).
    // Failure is logged but does not fail the request: the cursor write above
    // is the safe fallback while range recording is rolled out.
    if (
      body.from_height !== undefined &&
      typeof body.from_height === 'number' &&
      Number.isInteger(body.from_height) &&
      body.from_height >= 0 &&
      body.from_height <= body.last_block_scanned
    ) {
      const { error: rpcErr } = await ctx.serviceClient.rpc('record_stealth_scan_range', {
        p_connection_id: body.connection_id,
        p_from_height:   body.from_height,
        p_to_height:     body.last_block_scanned,
        p_app_user_id:   row.app_user_id as string,
      });
      if (rpcErr) {
        console.error('[or-stealth-envelope-update] record_stealth_scan_range failed:', rpcErr);
      }
    }

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
