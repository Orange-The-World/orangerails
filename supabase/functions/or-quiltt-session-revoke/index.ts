/**
 * or-quiltt-session-revoke. Revoke a Quiltt session token to free quota.
 *
 * Exposed via the API gateway at: POST /v1/quiltt/session-revoke
 *
 * Why this exists: Quiltt's per-Profile session-mint limit is 10 per hour
 * and 20 per day. Every POST to https://auth.quiltt.io/v1/users/sessions
 * counts against that limit, even if the previously minted token is still
 * valid. A consumer app testing the bank-link flow can burn the daily cap
 * in an afternoon. Per Quiltt's documented API (as of 2026-06-20), revoked
 * sessions do not count toward the limit, so this endpoint lets the consumer
 * app release a session it did not end up using and put the slot back. If
 * Quiltt later changes that policy, this endpoint is still safe to call but
 * the quota benefit no longer holds — confirm against Quiltt's current docs.
 *
 * Auth model: widget_token in the body. Same shape as the sister function
 * or-quiltt-session-via-widget. The widget_token proves the caller went
 * through or-link-mint-token for a known platform / app_user pair. The
 * session_token to revoke goes in the body so it stays out of our access
 * logs (we cannot speak to upstream Cloudflare / proxy logs further out).
 *
 * Binding check (defense in depth): before forwarding to Quiltt, the
 * function decodes the session JWT's `userId` (a Quiltt Profile id) and
 * verifies it matches the quiltt_profile_map row for the widget_token's
 * subaccount. So a caller with widget_token X can only revoke sessions
 * that belong to X's subaccount, not sessions belonging to other tenants.
 *
 * POST body:
 *   { widget_token: UUID,        // minted via or-link-mint-token
 *     session_token: string }    // the Quiltt session JWT to revoke
 *
 * Response 204: revoked (or session was already invalid; either way OR
 * has done what the caller asked).
 * Response 400: body missing or malformed.
 * Response 401: widget_token invalid, used, expired, OR session_token
 *               does not belong to the widget_token's subaccount.
 * Response 502: Quiltt returned 5xx or was unreachable; safe to retry.
 *
 * The widget_token is NOT consumed by this call. Same rule as
 * or-quiltt-session-via-widget: verification only. or-quiltt-link-complete
 * is still the one and only consumer of the widget_token.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.111.0";
import { buildCorsHeaders, jsonResponse, readBoundedText } from "../_shared/http.ts";
import { wrapSentryHandler } from '../_shared/sentry.ts';

const QUILTT_REVOKE_URL = "https://auth.quiltt.io/v1/users/session";

Deno.serve(wrapSentryHandler(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, cors);
  }

  try {
    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: "Request body too large" }, 413, cors);
    const body = JSON.parse(raw || "{}") as {
      widget_token?: string;
      session_token?: string;
    };

    if (!body.widget_token || typeof body.widget_token !== "string") {
      return jsonResponse(
        { error: "widget_token required", code: "body_missing_widget_token" },
        400,
        cors,
      );
    }
    if (!body.session_token || typeof body.session_token !== "string") {
      return jsonResponse(
        { error: "session_token required", code: "body_missing_session_token" },
        400,
        cors,
      );
    }

    const service = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Verify widget_token. Same rules as or-quiltt-session-via-widget:
    // unknown, used, or expired all return 401. We deliberately do NOT
    // consume the widget_token here; or-quiltt-link-complete remains the
    // only burn site. Distinct error codes help integrators tell a stale
    // token from a still-pending link.
    const session = await service
      .from("pending_widget_sessions")
      .select("id, platform_id, app_user_id, expires_at, used_at")
      .eq("id", body.widget_token)
      .maybeSingle();
    if (session.error || !session.data) {
      return jsonResponse(
        { error: "Invalid widget token", code: "widget_token_unknown" },
        401,
        cors,
      );
    }
    if (session.data.used_at) {
      return jsonResponse({ error: "Invalid widget token", code: "widget_token_used" }, 401, cors);
    }
    if (new Date(session.data.expires_at as string) < new Date()) {
      return jsonResponse(
        { error: "Invalid widget token", code: "widget_token_expired" },
        401,
        cors,
      );
    }

    // Binding check: verify the session_token belongs to this widget_token's
    // subaccount. Without this, an attacker holding ANY valid widget_token
    // could pass other tenants' session JWTs through and revoke them.
    // Decode the JWT payload (no signature verification; we only need the
    // userId field. Quiltt's DELETE call below does the real signature
    // check). Standard 3-part JWT: header.payload.signature.
    let jwtUserId: string | null = null;
    try {
      const parts = body.session_token.split(".");
      if (parts.length === 3) {
        const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const json = JSON.parse(atob(padded + "===".slice((padded.length + 3) % 4)));
        if (typeof json.userId === "string") jwtUserId = json.userId;
      }
    } catch {
      // Malformed JWT, fall through to bind check failure.
    }
    if (!jwtUserId) {
      return jsonResponse(
        { error: "Session token not bound", code: "session_token_unparseable" },
        401,
        cors,
      );
    }

    const subLookup = await service
      .from("subaccounts")
      .select("id")
      .eq("platform_id", session.data.platform_id)
      .eq("external_user_id", session.data.app_user_id)
      .maybeSingle();
    if (subLookup.error || !subLookup.data) {
      return jsonResponse(
        { error: "Session token not bound", code: "subaccount_missing" },
        401,
        cors,
      );
    }
    const mapLookup = await service
      .from("quiltt_profile_map")
      .select("quiltt_profile_id")
      .eq("subaccount_id", subLookup.data.id)
      .maybeSingle();
    if (mapLookup.error || !mapLookup.data) {
      return jsonResponse(
        { error: "Session token not bound", code: "profile_map_missing" },
        401,
        cors,
      );
    }
    if (mapLookup.data.quiltt_profile_id !== jwtUserId) {
      return jsonResponse(
        { error: "Session token not bound", code: "session_token_foreign" },
        401,
        cors,
      );
    }

    // DELETE auth.quiltt.io/v1/users/session, singular "session", per
    // Quiltt's OpenAPI spec. Auth is the session JWT itself, NOT the
    // master API key. Returns 204 on success, 401 if the session was
    // already revoked or expired. Either outcome is "done" from V2's view.
    const revokeResp = await fetch(QUILTT_REVOKE_URL, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${body.session_token}`,
        "Content-Type": "application/json",
      },
    });

    if (revokeResp.status === 204 || revokeResp.status === 401) {
      // 204: actually revoked. 401: session was already gone. Same result.
      return new Response(null, { status: 204, headers: cors });
    }

    // Drain the response body so the connection can be reused, but DO NOT
    // log its contents. Quiltt error bodies may echo the bearer / session
    // token back, and Supabase function logs are not user-consent-scoped.
    // Log status only.
    await revokeResp.text().catch(() => "<unreadable>");
    console.error(`[or-quiltt-session-revoke] Quiltt revoke failed: status=${revokeResp.status}`);
    return jsonResponse(
      { error: "Quiltt revoke failed", code: "quiltt_upstream_error" },
      502,
      cors,
    );
  } catch (err) {
    // Log only the error name + message. A raw Error object can stringify
    // into JSON.parse output that echoes part of the request body, which on
    // this endpoint contains the session_token JWT.
    const name = (err as { name?: unknown })?.name;
    const message = (err as { message?: unknown })?.message;
    console.error(
      `[or-quiltt-session-revoke] unexpected: name=${typeof name === "string" ? name : "Error"} message=${typeof message === "string" ? message.slice(0, 200) : "<unavailable>"}`,
    );
    return jsonResponse({ error: "Internal error" }, 500, cors);
  }
}, 'or-quiltt-session-revoke'));
