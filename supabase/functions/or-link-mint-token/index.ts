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
 *     ttl_seconds?: number  // optional, default 300 (5 minutes), max 300 (5 min)
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
import { wrapSentryHandler } from '../_shared/sentry.ts';

const DEFAULT_TTL_SECONDS = 300; // 5 minutes

/**
 * Ceiling on a minted session's lifetime, lowered from 900s to 300s.
 *
 * Why. A widget_token is a bearer credential: anyone holding it before it
 * expires can act as that app_user_id on that platform, and validation does
 * not consume it, so the exposure is the remaining TTL rather than a single
 * request. Shrinking the ceiling shrinks that window.
 *
 * Why the cap is global rather than scoped to the stealth flow. It cannot be
 * scoped: the token is minted BEFORE the widget opens, and the user picks a
 * provider from the catalogue afterwards. At mint time nobody, including this
 * function, knows whether the session will end up being a Stealth Sync
 * connection. A `flow` field in the body would not fix that either, because
 * the caller chooses what to put in it, so a caller wanting 900s would simply
 * omit it. That would be a convention, not a control.
 *
 * Why 300 is safe. Verified before changing it: no caller asks for more.
 * `pending_widget_sessions` holds 20 rows on dev, every one at ~300s
 * (max 299.96s, zero above 300), and is empty on prod, so no in-flight
 * production session can be stranded by the change. No caller in this repo
 * passes ttl_seconds at all.
 *
 * Behaviour is unchanged apart from the ceiling: an over-large request is
 * still clamped rather than rejected, so this cannot turn a working caller
 * into a 400.
 */
const MAX_TTL_SECONDS = 300; // 5 minutes

interface MintBody {
  app_user_id?: string;
  ttl_seconds?: number;
}

/**
 * Resolve the effective TTL for a mint request.
 *
 * Extracted so the clamping rules are testable without a request, a platform
 * key or a database. Anything absent, non-numeric, non-finite or below 1s
 * falls back to the default; anything above the ceiling is clamped to it.
 */
export function resolveTtlSeconds(raw: unknown): number {
  const ttl = raw ?? DEFAULT_TTL_SECONDS;
  if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl < 1) {
    return DEFAULT_TTL_SECONDS;
  }
  return ttl > MAX_TTL_SECONDS ? MAX_TTL_SECONDS : ttl;
}

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

    const ttl = resolveTtlSeconds(body.ttl_seconds);

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
}, 'or-link-mint-token'));
