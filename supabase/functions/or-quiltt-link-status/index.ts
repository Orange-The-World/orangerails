/**
 * or-quiltt-link-status — poll whether a Quiltt link attempt has completed.
 *
 * Why this exists (DL-1115). The Quiltt popup writes the connection row via
 * a keepalive POST that survives the popup closing, but the postMessage
 * that tells the OPENER the outcome cannot survive it: the document sending
 * it is gone. See src/routes/connect/quiltt.tsx onPageHide for the popup
 * side of this. That leaves the opener with no signal at all when the user
 * closes the popup mid-completion, even though the bank link succeeded.
 * This endpoint gives the opener a way to ask directly instead of guessing.
 *
 * Auth: X-Platform-API-Key (platform mode only). No widget mode, no direct
 * mode. Chosen over a browser-side widget-token poll (Auditor review,
 * DL-1829) because it dissolves three problems at once: the opener's own
 * origin is not on the CORS allow-list (_shared/http.ts), so a browser poll
 * could not reach any endpoint here without a wildcard change; a bearer
 * widget_token would need a post-burn read window bounded well below its
 * already-short mint TTL; and platformId comes off the API key rather than
 * the caller, so one platform cannot use this to ask about another
 * platform's users by construction, not by a checked predicate.
 *
 * POST body:
 *   app_user_id:   string   the integrating app's user id (same value
 *                           passed to or-link-mint-token and
 *                           or-quiltt-link-complete)
 *   widget_token?: string   OPTIONAL correlation id, the same UUID minted
 *                           by or-link-mint-token for this attempt. It is
 *                           NOT a credential here, the caller has already
 *                           authenticated with its platform key; it only
 *                           disambiguates when a platform has more than
 *                           one in-flight attempt for the same
 *                           app_user_id. Omit it to get the most recent
 *                           attempt.
 *
 * Response 200:
 *   { status: 'linked', connection_id: string, subaccount_id: string }
 *   { status: 'not_linked', connection_id: null, subaccount_id: null }
 *
 * 'not_linked' covers every state short of a confirmed success: no session
 * found for this (platform, app_user_id[, widget_token]), the session is
 * still mid-flight, or it expired without completing. The caller cannot
 * and should not tell those apart from this endpoint; give up after the
 * caller's own timeout, not because of a distinction made here.
 *
 * Response 400 — missing/malformed app_user_id or widget_token
 * Response 403 — authenticated but not in platform mode
 * Response 429 — rate limited (RATE_LIMIT_ENFORCE=true only; log-only by
 *                default, see _shared/rate-limit.ts)
 *
 * The read comes off pending_widget_sessions.completed_connection_id, a
 * column written by or-quiltt-link-complete at the moment a link actually
 * succeeds (see the write-back there). It is deliberately NOT computed by
 * reading "the most recent connections row for this subaccount": one
 * subaccount can hold several Quiltt connections (one Profile, many
 * banks), so that read would report an unrelated earlier link's success
 * for a later attempt that actually failed (Auditor, DL-1829, verified
 * against production data on lcdicqalreskibdfxkzb).
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, isAuthError } from '../_shared/platform-auth.ts';
import { checkPlatformRateLimit } from '../_shared/rate-limit.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';

interface LinkStatusBody {
  app_user_id?: string;
  widget_token?: string;
}

/**
 * A widget_token, when supplied, must be the uuid primary key of a
 * pending_widget_sessions row. Screen the shape before it reaches the
 * database: Postgres raises 22P02 on a malformed uuid, which would surface
 * as a 500 rather than the plain 400 a caller-side bug deserves.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidWidgetToken(token: unknown): boolean {
  return typeof token === 'string' && UUID_RE.test(token);
}

// Every 2s per client is the polling cadence the design assumes (DL-1115,
// DL-1829 R5). 40/minute leaves headroom for a client's own retry jitter
// without opening the door to a tight loop.
const MAX_PER_MINUTE = 40;

Deno.serve(wrapSentryHandler(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  try {
    const auth = await authenticateRequest(req);
    if (isAuthError(auth)) {
      return jsonResponse({ error: auth.message }, auth.status, cors);
    }
    if (auth.mode !== 'platform') {
      return jsonResponse(
        { error: 'or-quiltt-link-status requires platform-mode auth (X-Platform-API-Key)' },
        403,
        cors,
      );
    }

    const limit = await checkPlatformRateLimit({
      supabase: auth.serviceClient,
      key: auth.platformId,
      scope: 'or-quiltt-link-status',
      maxPerMinute: MAX_PER_MINUTE,
    });
    if (!limit.allowed) {
      return jsonResponse(
        { error: 'rate_limited', detail: `Try again in ${limit.retryAfterSeconds}s` },
        429,
        { ...cors, 'retry-after': String(limit.retryAfterSeconds) },
      );
    }

    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);
    const body = JSON.parse(raw || '{}') as LinkStatusBody;

    if (!body.app_user_id || typeof body.app_user_id !== 'string' || body.app_user_id.length > 256) {
      return jsonResponse({ error: 'app_user_id required (string, ≤256 chars)' }, 400, cors);
    }
    if (body.widget_token !== undefined && !isValidWidgetToken(body.widget_token)) {
      return jsonResponse({ error: 'widget_token must be a uuid' }, 400, cors);
    }

    // Scoped to (platform_id, app_user_id) always, platform_id off the key
    // so one platform can only ever ask about its own users. widget_token,
    // when given, narrows to one specific attempt; otherwise take the most
    // recent one for this user.
    const session = body.widget_token
      ? await auth.serviceClient
          .from('pending_widget_sessions')
          .select('completed_connection_id')
          .eq('platform_id', auth.platformId)
          .eq('app_user_id', body.app_user_id)
          .eq('id', body.widget_token)
          .maybeSingle()
      : await auth.serviceClient
          .from('pending_widget_sessions')
          .select('completed_connection_id')
          .eq('platform_id', auth.platformId)
          .eq('app_user_id', body.app_user_id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

    if (session.error) {
      console.error('[or-quiltt-link-status] session lookup failed:', session.error.message);
      return jsonResponse({ error: 'Failed to look up link status' }, 500, cors);
    }

    const connectionId = session.data?.completed_connection_id as string | null | undefined;
    if (!connectionId) {
      return jsonResponse({ status: 'not_linked', connection_id: null, subaccount_id: null }, 200, cors);
    }

    const conn = await auth.serviceClient
      .from('connections')
      .select('subaccount_id')
      .eq('id', connectionId)
      .maybeSingle();
    if (conn.error || !conn.data) {
      // completed_connection_id points at a row that is gone. Should not
      // happen outside manual data surgery; answer "not_linked" rather than
      // 500ing, which is still an honest "we cannot confirm a link" answer.
      console.error(
        '[or-quiltt-link-status] completed_connection_id points at a missing connection:',
        connectionId,
      );
      return jsonResponse({ status: 'not_linked', connection_id: null, subaccount_id: null }, 200, cors);
    }

    return jsonResponse(
      { status: 'linked', connection_id: connectionId, subaccount_id: conn.data.subaccount_id as string },
      200,
      cors,
    );
  } catch (e) {
    console.error('[or-quiltt-link-status] fatal:', e instanceof Error ? e.message : String(e));
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
}, 'or-quiltt-link-status'));
