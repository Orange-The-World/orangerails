/**
 * or-stealth-envelope-update -- advance the scan-tip cursor for a stealth connection.
 *
 * Master plan: STEALTH-SYNC-MASTER-PLAN.md section 4.6.
 *
 * Called by the widget in step 4 of the sync flow (sync.tsx lines 286-337),
 * after or-stealth-transactions-store has stored any new sealed transactions.
 * That function advances last_block_scanned only to the max block_height of
 * rows it actually committed, so a sync that found zero matching transactions
 * would never move the window forward. This one advances the cursor to the
 * height the caller reports having scanned, which is why the widget calls it on
 * every sync and not only on syncs that stored something.
 *
 * WHAT THE REPORTED HEIGHT MEANS, and where that is decided. Not here: the
 * contract for this column is defined once, in ../_shared/scan-cursor.ts, and
 * both endpoints that write it import from there. In short, last_block_scanned
 * is the last height the CALLER SCANNED CONTIGUOUSLY. It is not a chain tip.
 * Until OR-T1914 this header called it exactly that, while the sibling endpoint
 * capped the same column at the contiguous height, so one column carried two
 * opposite contracts and the weaker one won.
 *
 * POST body:
 *   connection_id:            string (uuid)
 *   app_user_id:              string
 *   last_block_scanned:       number (non-negative integer, the last height
 *                             scanned CONTIGUOUSLY, not a chain tip)
 *   from_height:              number, optional (see below)
 *   contiguous_block_scanned: number, optional. For a caller that distinguishes
 *                             its scan tip from the point it actually read to:
 *                             the cursor is then capped at the lower of the two.
 *                             A caller whose last_block_scanned is already the
 *                             contiguous height gains nothing by repeating it.
 *                             The value is a ceiling only, so it can hold the
 *                             cursor back and can never push it forward.
 *   scan_generation:          string (uuid), REQUIRED. The connection's
 *                             scan_generation as read at the START of this
 *                             sync (OR-T2457). Refused with 400 if absent or
 *                             malformed, and with 409 if it no longer matches
 *                             the connection's current value: that means the
 *                             connection was reset (envelope replaced) while
 *                             this sync was running, and last_block_scanned /
 *                             the scan range this call would otherwise write
 *                             both predate that reset.
 *
 * Response:
 *   { connection_id, last_block_scanned }
 *   last_block_scanned reflects the stored cursor after the call. It may be
 *   higher than the supplied value when a concurrent call already advanced it,
 *   and lower when the contiguity ceiling applied.
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
import { recordScanRange } from './scan_range.ts';

interface EnvelopeUpdateRequestBody {
  connection_id?: string;
  app_user_id?: string;
  last_block_scanned?: number;
  /** See scan_generation in the module doc above. Required, uuid-shaped. */
  scan_generation?: string;
  /**
   * Optional contiguity ceiling (OR-T1914). The last height the caller read
   * WITHOUT a gap. When present, the cursor advances to at most
   * min(last_block_scanned, contiguous_block_scanned).
   *
   * It exists because a rolling-window extension pass can match a transaction
   * above the height where a filter fetch aborted, so a caller can legitimately
   * hold two different numbers. Sending the higher one as the cursor makes the
   * next sync resume above a range nobody read, and a payment inside that range
   * is then lost silently. A caller that holds only one number sends only
   * last_block_scanned, which the contract already requires to be the
   * contiguous height.
   */
  contiguous_block_scanned?: number;
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
    // OR-T2457: refused rather than defaulted. A caller with no fresh
    // generation is indistinguishable from one carrying a stale one, so
    // there is no safe permissive fallback the way there is for the
    // contiguous_block_scanned ceiling below.
    if (!body.scan_generation || !UUID_RE.test(body.scan_generation)) {
      return jsonResponse({ error: 'scan_generation (uuid) required' }, 400, cors);
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
    // A malformed ceiling is rejected rather than ignored. Falling through would
    // treat "I sent a ceiling and got it wrong" as "I sent no ceiling", which is
    // the unbounded path, and the caller would never learn its guard was dropped.
    if (
      body.contiguous_block_scanned !== undefined &&
      (typeof body.contiguous_block_scanned !== 'number' ||
        !Number.isInteger(body.contiguous_block_scanned) ||
        body.contiguous_block_scanned < 0)
    ) {
      return jsonResponse(
        { error: 'contiguous_block_scanned must be a non-negative integer when present' },
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
      body.scan_generation,
      body.contiguous_block_scanned,
    );
    if (isAdvanceCursorError(cursorResult)) {
      return jsonResponse({ error: cursorResult.error }, cursorResult.status, cors);
    }
    const effectiveCursor = cursorResult.effectiveCursor;
    // The height this call was allowed to claim, after the contiguity ceiling
    // (OR-T1914). Equal to body.last_block_scanned whenever no ceiling was sent
    // or the ceiling was not lower.
    const boundedHeight = cursorResult.boundedHeight;

    // Record the scan range when the caller supplies from_height (DL-1478).
    //
    // The row read above is deliberately NOT passed here. record_stealth_scan_range
    // resolves the owner from stealth_connections itself and rejects unless the
    // id it is given matches: hand it the value we just read from that same row
    // and it compares the owner against itself, so the check can never fail.
    // recordScanRange only ever sees the request body, which carries the caller
    // identity, token-pinned above (direct: equals ctx.userId, widget:
    // enforceWidgetAppUser, platform: scoped by platform_id on the row read).
    // DL-1597.
    await recordScanRange(ctx.serviceClient, {
      connection_id:      body.connection_id,
      app_user_id:        body.app_user_id,
      // The BOUNDED height, not the posted one. A range recorded as
      // [from_height, posted] while the cursor was only allowed to reach the
      // lower bounded height would be read back by the resume path as coverage
      // for blocks nobody scanned, which is the same silent loss the ceiling
      // exists to prevent, written into a different table.
      last_block_scanned: boundedHeight,
      from_height:        body.from_height,
      // OR-T2457: same token advanceCursor above just checked. The database
      // function checks it again independently; it does not trust that the
      // cursor write having succeeded means this one may proceed.
      scan_generation:    body.scan_generation,
    });

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
