/**
 * or-discover-wallets -- list available wallets from the upstream provider.
 *
 * Two modes:
 *
 * 1. CONNECTION MODE (existing behaviour, unchanged):
 *    Auth: X-Platform-API-Key or Supabase JWT.
 *    Body: { connection_id, credentials_key, subaccount_id? }
 *    Decrypts the stored encrypted_credentials for an existing connection.
 *
 * 2. RAW-CREDENTIALS MODE (new, for the /connect widget pre-link flow):
 *    Auth: widget_token (same short-lived session token minted by
 *          or-link-mint-token, validated the same way or-link-complete does).
 *    Body: { platform_slug, app_user_id, provider_type,
 *            encrypted_credentials, credentials_key, widget_token }
 *    No connection_id required. Writes one discovery_sessions row per
 *    discovered wallet (the internal external_wallet_id -> account_key map,
 *    service-role only, stripped from the response); no other DB rows.
 *    Token is validated (platform_id + app_user_id + expiry + used_at IS NULL)
 *    but NOT consumed -- used_at is left null so the same token can
 *    authenticate the subsequent or-link-complete call. Single-use
 *    enforcement remains in or-link-complete only.
 *
 * In both modes the adapter's discoverWallets() is called with decrypted
 * credentials in memory; the credentials themselves are never persisted. Raw
 * mode does record the internal account_key -> external_wallet_id map in
 * discovery_sessions (server-side only) so the write path can dedup; that map
 * and the wallet_fingerprint are stripped before any client response.
 *
 * Response (both modes):
 *   { discovered_wallets: [{ external_wallet_id, currency, label? }] }
 *
 * wallet_fingerprint (internal HMAC dedup key) is stripped before the response
 * leaves the server. It must never appear in any external API response body.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.111.0";
import { buildCorsHeaders, jsonResponse, readBoundedText } from "../_shared/http.ts";
import { authenticateRequest, resolveSubaccount, isAuthError } from "../_shared/platform-auth.ts";
import { getProvider, listProviderSlugs, parseCredentials } from "../_shared/providers/dispatch.ts";
import { wrapSentryHandler } from "../_shared/sentry.ts";
import { lookupErrorCopy } from "../_shared/error-catalog.ts";
import { safeErrorLine } from "../_shared/error-redaction.ts";

// -- AES-256-GCM helpers (kept inline for edge-fn isolation) ----------------

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Exported so index.test.ts can assert the usages array directly, not just
// that decryption still works (which it would even with an extra unused
// usage).
export async function importAesKey(base64Key: string): Promise<CryptoKey> {
  const keyBytes = base64ToBytes(base64Key);
  return crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "AES-GCM" },
    false,
    // "decrypt" only: neither mode of this handler ever encrypts (OR-T0723).
    ["decrypt"],
  );
}

async function decryptAes(ciphertextB64: string, key: CryptoKey): Promise<string> {
  const data = base64ToBytes(ciphertextB64);
  const iv = data.slice(0, 12);
  const cipher = data.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return new TextDecoder().decode(plain);
}

function makeServiceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
}

// -- Main handler ------------------------------------------------------------

Deno.serve(
  wrapSentryHandler(async (req: Request) => {
    const cors = buildCorsHeaders(req);
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, cors);

    try {
      const raw = await readBoundedText(req);
      if (raw === null) return jsonResponse({ error: "Request body too large" }, 413, cors);

      const body = JSON.parse(raw || "{}") as Record<string, unknown>;

      // -----------------------------------------------------------------------
      // RAW-CREDENTIALS MODE: widget_token present, no connection_id.
      // -----------------------------------------------------------------------
      if (body.widget_token && !body.connection_id) {
        const platformSlug = body.platform_slug;
        const appUserId = body.app_user_id;
        const providerType = body.provider_type;
        const encryptedCredentials = body.encrypted_credentials;
        const credentialsKey = body.credentials_key;
        const widgetToken = body.widget_token;

        if (!platformSlug || typeof platformSlug !== "string") {
          return jsonResponse({ error: "platform_slug required" }, 400, cors);
        }
        if (!appUserId || typeof appUserId !== "string" || (appUserId as string).length > 256) {
          return jsonResponse({ error: "app_user_id required (string, <=256 chars)" }, 400, cors);
        }
        if (!providerType || typeof providerType !== "string") {
          return jsonResponse(
            { error: `provider_type must be one of: ${listProviderSlugs().join(", ")}` },
            400,
            cors,
          );
        }
        if (
          !encryptedCredentials ||
          typeof encryptedCredentials !== "string" ||
          (encryptedCredentials as string).length > 65536
        ) {
          return jsonResponse(
            { error: "encrypted_credentials required (base64, <=64 KB)" },
            400,
            cors,
          );
        }
        if (!credentialsKey || typeof credentialsKey !== "string") {
          return jsonResponse({ error: "credentials_key required (base64 ORK)" }, 400, cors);
        }
        if (typeof widgetToken !== "string") {
          return jsonResponse({ error: "widget_token must be a string" }, 400, cors);
        }

        const adapter = getProvider(providerType as string);
        if (!adapter) {
          return jsonResponse(
            { error: `provider_type must be one of: ${listProviderSlugs().join(", ")}` },
            400,
            cors,
          );
        }

        const serviceClient = makeServiceClient();

        // Resolve platform.
        const { data: platform, error: platErr } = await serviceClient
          .from("platforms")
          .select("id, slug")
          .eq("slug", platformSlug)
          .maybeSingle();
        if (platErr || !platform) {
          return jsonResponse({ error: "Unknown platform" }, 404, cors);
        }

        // Validate widget token READ-ONLY. Do NOT set used_at here.
        // The token must survive to authenticate the subsequent or-link-complete call.
        // Single-use enforcement (the atomic UPDATE that sets used_at) stays in
        // or-link-complete only. Two parallel discover calls with the same token
        // are harmless: no rows are written and the wallet list is identical.
        const { data: session, error: sessionErr } = await serviceClient
          .from("pending_widget_sessions")
          .select("id, expires_at")
          .eq("id", widgetToken)
          .is("used_at", null)
          .gt("expires_at", new Date().toISOString())
          .eq("platform_id", platform.id)
          .eq("app_user_id", appUserId)
          .maybeSingle();

        if (sessionErr) {
          console.error(await safeErrorLine("or-discover-wallets", "widget-token-lookup", sessionErr));
          return jsonResponse({ error: "Invalid widget token" }, 401, cors);
        }
        if (!session) {
          return jsonResponse({ error: "Invalid widget token" }, 401, cors);
        }

        // Decrypt credentials in memory only. Never persisted.
        const credsKey = await importAesKey(credentialsKey as string);
        const credsJson = await decryptAes(encryptedCredentials as string, credsKey);
        const credentials = parseCredentials(adapter, credsJson);

        const discovered = await adapter.discoverWallets(credentials);

        // Record the account_key -> external_wallet_id map server-side so the
        // write path can compute the dedup fingerprint without the real account
        // key ever crossing to the client. One row per discovered wallet that
        // carries an account_key; rows cascade-delete with the widget session.
        // external_wallet_id is a fresh random UUID per discovery, so repeated
        // or parallel discover calls write independent, harmless rows.
        const sessionRows = discovered
          .filter((w) => typeof w.account_key === "string" && w.account_key.length > 0)
          .map((w) => ({
            widget_session_id: widgetToken,
            external_wallet_id: w.external_wallet_id,
            provider_type: providerType,
            account_key: w.account_key,
            currency: w.currency,
            expires_at: session.expires_at,
          }));
        if (sessionRows.length > 0) {
          const { error: insErr } = await serviceClient
            .from("discovery_sessions")
            .insert(sessionRows);
          if (insErr) {
            // Without the session rows the write path cannot dedup this
            // discovery, so fail loudly rather than silently degrade.
            console.error(await safeErrorLine("or-discover-wallets", "discovery-sessions-insert", insErr));
            return jsonResponse({ error: "Could not record discovery session" }, 500, cors);
          }
        }

        // Strip the internal-only fields (wallet_fingerprint dedup key and the
        // real account_key) before returning. Neither may appear in any external
        // API response body (Auditor gate 4).
        const stripped = discovered.map(
          ({ wallet_fingerprint: _fp, account_key: _ak, ...rest }) => rest,
        );
        return jsonResponse({ discovered_wallets: stripped }, 200, cors);
      }

      // -----------------------------------------------------------------------
      // CONNECTION MODE: existing behaviour, unchanged.
      // -----------------------------------------------------------------------
      const ctx = await authenticateRequest(req);
      if (isAuthError(ctx)) return jsonResponse({ error: ctx.message }, ctx.status, cors);

      if (!body.connection_id || typeof body.connection_id !== "string") {
        return jsonResponse({ error: "connection_id required" }, 400, cors);
      }
      if (!body.credentials_key || typeof body.credentials_key !== "string") {
        return jsonResponse({ error: "credentials_key required (base64 ORK)" }, 400, cors);
      }

      const subaccountId = await resolveSubaccount(ctx, body.subaccount_id as string | undefined);
      if (isAuthError(subaccountId)) {
        return jsonResponse({ error: subaccountId.message }, subaccountId.status, cors);
      }

      // Verify caller owns the connection (subaccount join enforces ownership in
      // both direct and platform modes).
      const { data: conn, error: connErr } = await ctx.serviceClient
        .from("connections")
        .select("id, provider_type, encrypted_credentials, subaccount_id")
        .eq("id", body.connection_id)
        .eq("subaccount_id", subaccountId)
        .maybeSingle();

      if (connErr) {
        console.error(await safeErrorLine("or-discover-wallets", "connection-lookup", connErr));
        return jsonResponse({ error: "Connection lookup failed" }, 500, cors);
      }
      if (!conn) return jsonResponse({ error: "Connection not found" }, 404, cors);

      const adapter = getProvider(conn.provider_type as string);
      if (!adapter) {
        return jsonResponse({ error: `Unknown provider: ${conn.provider_type}` }, 400, cors);
      }

      // Decrypt credentials in memory only; never persisted.
      const credsKey = await importAesKey(body.credentials_key as string);
      const credsJson = await decryptAes(conn.encrypted_credentials as string, credsKey);
      const credentials = parseCredentials(adapter, credsJson);

      const discovered = await adapter.discoverWallets(credentials);

      // Connection mode does not run the widget link flow (no widget session to
      // key a discovery_sessions row on), so it records no server-side map. It
      // still strips the internal-only fields (wallet_fingerprint dedup key and
      // the real account_key) before returning: neither may appear in any
      // external API response body (Auditor gate 4).
      const stripped = discovered.map(
        ({ wallet_fingerprint: _fp, account_key: _ak, ...rest }) => rest,
      );
      return jsonResponse({ discovered_wallets: stripped }, 200, cors);
    } catch (err) {
      // When discoverWallets throws with upstreamCode, surface the OR error code
      // and customer copy. Preserves the distinction between auth failures
      // (bad key -> UPSTREAM_AUTH_FAILED) and transient outages
      // (UPSTREAM_UNAVAILABLE, UPSTREAM_RATE_LIMITED).
      const upstreamCode =
        err instanceof Error ? (err as any).upstreamCode as string | undefined : undefined;
      if (upstreamCode) {
        const catalog = lookupErrorCopy(upstreamCode);
        const status =
          upstreamCode === 'UPSTREAM_RATE_LIMITED' ? 429
          : upstreamCode === 'UPSTREAM_UNAVAILABLE' ? 503
          : 422;
        return jsonResponse({ error_code: upstreamCode, ...catalog }, status, cors);
      }
      // Never log `err` itself. On the credential paths this can be a
      // JSON.parse SyntaxError over decrypted plaintext, and V8 embeds part of
      // the input string in that message. safeErrorLine emits a code, a class,
      // a hash and a correlation id, and drops the message.
      console.error(await safeErrorLine("or-discover-wallets", "fatal", err));
      return jsonResponse({ error: "Internal error" }, 500, cors);
    }
  }, "or-discover-wallets"),
);
