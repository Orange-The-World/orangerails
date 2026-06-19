/**
 * or-link-mint-token , issue a short-lived widget session token.
 *
 * Audit 2026-05-16 High #3.
 *
 * Background: or-link-complete (the endpoint the Connect popup hits when a
 * user finishes adding a wallet) was unauthenticated since launch. Anyone
 * on the public internet could POST and create junk subaccounts under any
 * platform. The fix is the standard "short-lived signed handoff" pattern:
 * the integrating app's BACKEND calls this endpoint server-to-server with
 * its platform API key, gets back a one-time token, includes that token in
 * the widget URL it opens for the user, and the widget passes the token
 * along when it calls or-link-complete. or-link-complete then verifies the
 * token and marks it used.
 *
 * Auth: X-Platform-API-Key (platform mode only). Direct mode users don't
 * use this flow.
 *
 * POST body:
 *   {
 *     app_user_id: string   // the integrating app's user identifier
 *     ttl_seconds?: number  // optional, default 300 (5 minutes), max 900 (15 min)
 *   }
 *
 * Response 200:
 *   {
 *     widget_token: string  // the UUID the integrating app passes to the widget
 *     expires_at: string    // ISO 8601 timestamp when the token stops working
 *   }
 *
 * The token is single-use: or-link-complete marks used_at on consumption.
 * Replay attempts (same token twice) fail.
 *
 * Integrators include the widget_token in the widget URL fragment:
 *   https://connect.orangerails.com/?platform=...&app_user_id=...#widget_token=<token>&cred_key=...&txn_key=...
 *
 * The widget then includes it in the or-link-complete request body.
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, isAuthError } from '../_shared/platform-auth.ts';

const DEFAULT_TTL_SECONDS = 300; // 5 minutes
const MAX_TTL_SECONDS = 900; // 15 minutes

interface MintBody {
  app_user_id?: string;
  ttl_seconds?: number;
}

Deno.serve(async (req: Request) => {
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
        { error: 'or-link-mint-token requires platform-mode auth (X-Platform-API-Key)' },
        403,
        cors,
      );
    }

    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);
    const body = JSON.parse(raw || '{}') as MintBody;

    if (!body.app_user_id || typeof body.app_user_id !== 'string' || body.app_user_id.length > 256) {
      return jsonResponse({ error: 'app_user_id required (string, ≤256 chars)' }, 400, cors);
    }

    let ttl = body.ttl_seconds ?? DEFAULT_TTL_SECONDS;
    if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl < 1) {
      ttl = DEFAULT_TTL_SECONDS;
    }
    if (ttl > MAX_TTL_SECONDS) ttl = MAX_TTL_SECONDS;

    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    const { data, error } = await auth.serviceClient
      .from('pending_widget_sessions')
      .insert({
        platform_id: auth.platformId,
        app_user_id: body.app_user_id,
        expires_at: expiresAt,
      })
      .select('id')
      .single();

    if (error || !data) {
      console.error('[or-link-mint-token] insert failed:', error?.message);
      return jsonResponse({ error: 'Failed to mint widget token' }, 500, cors);
    }

    return jsonResponse(
      {
        widget_token: data.id as string,
        expires_at: expiresAt,
      },
      200,
      cors,
    );
  } catch (e) {
    console.error('[or-link-mint-token] error:', e instanceof Error ? e.message : String(e));
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
});
