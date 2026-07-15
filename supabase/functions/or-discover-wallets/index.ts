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
 *    No connection_id required. No DB rows written.
 *    Token is validated (platform_id + app_user_id + expiry + used_at IS NULL)
 *    but NOT consumed -- used_at is left null so the same token can
 *    authenticate the subsequent or-link-complete call. Single-use
 *    enforcement remains in or-link-complete only.
 *
 * In both modes the adapter's discoverWallets() is called with decrypted
 * credentials in memory. The server never persists discovered wallet data.
 *
 * Response (both modes):
 *   { discovered_wallets: [{ external_wallet_id, currency, label? }] }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildCorsHeaders, jsonResponse, readBoundedText } from "../_shared/http.ts";
import { authenticateRequest, resolveSubaccount, isAuthError } from "../_shared/platform-auth.ts";
import { getProvider, listProviderSlugs, parseCredentials } from "../_shared/providers/dispatch.ts";
import { wrapSentryHandler } from "../_shared/sentry.ts";

// -- AES-256-GCM helpers (kept inline for edge-fn isolation) ----------------

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importAesKey(base64Key: string): Promise<CryptoKey> {
  const keyBytes = base64ToBytes(base64Key);
  return crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
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
          .select("id")
          .eq("id", widgetToken)
          .is("used_at", null)
          .gt("expires_at", new Date().toISOString())
          .eq("platform_id", platform.id)
          .eq("app_user_id", appUserId)
          .maybeSingle();

        if (sessionErr) {
          console.error("[or-discover-wallets] widget token lookup error:", sessionErr.message);
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

        return jsonResponse({ discovered_wallets: discovered }, 200, cors);
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
        console.error("[or-discover-wallets] connection lookup failed:", connErr);
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

      return jsonResponse({ discovered_wallets: discovered }, 200, cors);
    } catch (err) {
      console.error("[or-discover-wallets] fatal:", err);
      return jsonResponse({ error: "Internal error" }, 500, cors);
    }
  }, "or-discover-wallets"),
);
