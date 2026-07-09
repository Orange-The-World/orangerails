/**
 * or-stealth-envelope-update: persist the sync cursor for a stealth
 * connection, without requiring a transaction upload.
 *
 * Naming note: the function name is fixed by consumer-side proxy
 * allow-lists that already include it, which is why it says "envelope"
 * while the envelope itself is only ever replaced in
 * or-stealth-connection-create.
 *
 * Why this exists: the widget's sync starts from
 * max(birthday_height, last_block_scanned + 1). Until now the cursor
 * only advanced inside or-stealth-transactions-store, which consumer
 * apps that set skip_transaction_upload never call (and which nobody
 * calls on a sync that found zero new transactions). Result: those
 * syncs rescanned the whole birthday-to-tip window every time. The
 * widget now posts the cursor here at the end of every successful
 * sync, whether or not transactions were uploaded.
 *
 * POST body:
 *   connection_id:      string (uuid, required)
 *   app_user_id:        string (required)
 *   app_slug:           string (optional, defense-in-depth filter)
 *   last_block_scanned: number (required, non-negative integer)
 *
 * Rules:
 *   - The cursor only moves FORWARD here. A value at or below the stored
 *     cursor is acknowledged but not written (idempotent, and a stale or
 *     buggy client cannot rewind another tab's progress). Cursor RESETS
 *     (for a changed wallet birthday or an explicit full rescan) happen in
 *     or-stealth-connection-create when the envelope is replaced, not here.
 *
 * Response:
 *   { connection_id, last_block_scanned, updated }
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, isAuthError, getCallerPlatformId } from '../_shared/platform-auth.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';

interface EnvelopeUpdateRequestBody {
  connection_id?: string;
  app_user_id?: string;
  app_slug?: string;
  last_block_scanned?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Plausibility ceiling for a block height. Bitcoin adds ~52,600 blocks a
// year, so real heights stay far below this for well over a century. A
// cursor poisoned with an absurdly high value would make every future
// sync silently skip real blocks, and the forward-only rule would make
// that sticky, so nonsense is rejected outright.
const MAX_PLAUSIBLE_HEIGHT = 10_000_000;

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
      typeof body.last_block_scanned !== 'number' ||
      !Number.isInteger(body.last_block_scanned) ||
      body.last_block_scanned < 0 ||
      body.last_block_scanned > MAX_PLAUSIBLE_HEIGHT
    ) {
      return jsonResponse(
        { error: `last_block_scanned must be an integer between 0 and ${MAX_PLAUSIBLE_HEIGHT}` },
        400, cors,
      );
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

    // Every stealth_connections read/write must be scoped to the calling
    // platform, derived server-side from the API key. Resolve once here.
    const platformIdOrErr = await getCallerPlatformId(ctx);
    if (isAuthError(platformIdOrErr)) {
      return jsonResponse({ error: platformIdOrErr.message }, platformIdOrErr.status, cors);
    }
    const callerPlatformId = platformIdOrErr;

    let query = ctx.serviceClient
      .from('stealth_connections')
      .select('id, last_block_scanned')
      .eq('platform_id', callerPlatformId)
      .eq('id', body.connection_id)
      .eq('app_user_id', body.app_user_id);
    if (body.app_slug) {
      query = query.eq('app_slug', body.app_slug);
    }
    const { data: row, error: selErr } = await query.maybeSingle();

    if (selErr) {
      console.error('[or-stealth-envelope-update] select failed:', selErr);
      return jsonResponse({ error: 'Failed to load stealth connection' }, 500, cors);
    }
    if (!row) {
      return jsonResponse({ error: 'Connection not found' }, 404, cors);
    }

    const stored = (row.last_block_scanned as number | null) ?? -1;
    if (body.last_block_scanned <= stored) {
      // Forward-only: acknowledge without writing.
      return jsonResponse(
        {
          connection_id: row.id as string,
          last_block_scanned: stored,
          updated: false,
        },
        200, cors,
      );
    }

    // Same pins as the select (platform, id, app_user_id), plus an
    // atomic forward-only guard: without the .or filter, two interleaved
    // requests could land a lower cursor after a higher one.
    let update = ctx.serviceClient
      .from('stealth_connections')
      .update({
        last_block_scanned: body.last_block_scanned,
        last_sync_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('platform_id', callerPlatformId)
      .eq('id', row.id as string)
      .eq('app_user_id', body.app_user_id)
      .or(`last_block_scanned.is.null,last_block_scanned.lt.${body.last_block_scanned}`);
    if (body.app_slug) {
      update = update.eq('app_slug', body.app_slug);
    }
    const { error: updErr } = await update;

    if (updErr) {
      console.error('[or-stealth-envelope-update] update failed:', updErr);
      return jsonResponse({ error: 'Failed to update sync cursor' }, 500, cors);
    }

    return jsonResponse(
      {
        connection_id: row.id as string,
        last_block_scanned: body.last_block_scanned,
        updated: true,
      },
      200, cors,
    );
  } catch (err) {
    console.error('[or-stealth-envelope-update] fatal:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
}));
