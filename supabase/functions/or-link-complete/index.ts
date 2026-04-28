/**
 * or-link-complete — end of the /connect Link widget round trip.
 *
 * Called by the unauthenticated /connect widget after the end user has
 * pasted their provider API key and picked which discovered wallets to
 * sync. Provisions the subaccount (idempotent), stores the encrypted
 * credential, and creates one source_wallet per picked entry. Returns
 * the array of source_wallet_ids so the integrating app can persist them.
 *
 * Auth: by-platform-slug. The widget runs in the end user's browser with
 * no platform secret. A future hardening pass can replace this with a
 * short-lived widget session token issued server-to-server when the
 * integrating app opens the widget URL.
 *
 * POST body (preferred, multi-wallet):
 *   platform_slug:          string  e.g. 'bitbooks-v2'
 *   app_user_id:            string  the integrating app's user ID
 *   provider_type:          string  'blink' for now
 *   encrypted_label:        string  base64 AES-256-GCM ciphertext (connection-level label)
 *   encrypted_credentials:  string  base64 AES-256-GCM ciphertext (provider API key)
 *   wallets: Array<{
 *     external_wallet_id:    string   opaque provider wallet ID
 *     encrypted_metadata:    string   base64 AES-256-GCM ciphertext (currency/label)
 *   }>
 *
 * POST body (legacy single-wallet, still accepted):
 *   external_wallet_id:     string
 *   encrypted_metadata:     string
 *
 * Response 200:
 *   {
 *     subaccount_id, connection_id,
 *     source_wallets: [{ id, external_wallet_id }, ...],
 *     // Backward-compat: if exactly one wallet was created, also return source_wallet_id.
 *     source_wallet_id?: string
 *   }
 *
 * Response 404 if platform_slug unknown; 400 on missing fields.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildCorsHeaders, jsonResponse, readBoundedText } from "../_shared/http.ts";

const ALLOWED_PROVIDERS = new Set(["blink"]);
const MAX_WALLETS_PER_CALL = 50;
const MAX_ENCRYPTED_METADATA_LEN = 8192;

interface InboundWallet {
  external_wallet_id?: string;
  encrypted_metadata?: string;
}

interface LinkCompleteBody {
  platform_slug?: string;
  app_user_id?: string;
  provider_type?: string;
  encrypted_label?: string;
  encrypted_credentials?: string;
  // New multi-wallet shape
  wallets?: InboundWallet[];
  // Legacy single-wallet shape
  external_wallet_id?: string;
  encrypted_metadata?: string;
}

function makeServiceClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
}

Deno.serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, cors);

  try {
    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: "Request body too large" }, 413, cors);

    const body = JSON.parse(raw || "{}") as LinkCompleteBody;

    if (!body.platform_slug || typeof body.platform_slug !== "string") {
      return jsonResponse({ error: "platform_slug required" }, 400, cors);
    }
    if (
      !body.app_user_id ||
      typeof body.app_user_id !== "string" ||
      body.app_user_id.length > 256
    ) {
      return jsonResponse({ error: "app_user_id required (string, ≤256 chars)" }, 400, cors);
    }
    if (!body.provider_type || !ALLOWED_PROVIDERS.has(body.provider_type)) {
      return jsonResponse(
        { error: `provider_type must be one of: ${[...ALLOWED_PROVIDERS].join(", ")}` },
        400,
        cors,
      );
    }
    if (!body.encrypted_credentials || body.encrypted_credentials.length > 65536) {
      return jsonResponse({ error: "encrypted_credentials required (base64, ≤64 KB)" }, 400, cors);
    }

    // Normalize wallet shape — accept either the new `wallets` array or the
    // legacy single-wallet (external_wallet_id + encrypted_metadata) fields.
    let wallets: InboundWallet[] = [];
    if (Array.isArray(body.wallets) && body.wallets.length > 0) {
      wallets = body.wallets;
    } else if (body.external_wallet_id && body.encrypted_metadata) {
      wallets = [
        {
          external_wallet_id: body.external_wallet_id,
          encrypted_metadata: body.encrypted_metadata,
        },
      ];
    } else {
      return jsonResponse(
        { error: "wallets array required (or legacy external_wallet_id + encrypted_metadata)" },
        400,
        cors,
      );
    }

    if (wallets.length > MAX_WALLETS_PER_CALL) {
      return jsonResponse({ error: `Too many wallets (max ${MAX_WALLETS_PER_CALL})` }, 413, cors);
    }
    for (const w of wallets) {
      if (!w || typeof w !== "object") {
        return jsonResponse({ error: "Each wallet must be an object" }, 400, cors);
      }
      if (!w.external_wallet_id || typeof w.external_wallet_id !== "string") {
        return jsonResponse({ error: "external_wallet_id required on each wallet" }, 400, cors);
      }
      if (!w.encrypted_metadata || typeof w.encrypted_metadata !== "string") {
        return jsonResponse({ error: "encrypted_metadata required on each wallet" }, 400, cors);
      }
      if (w.encrypted_metadata.length > MAX_ENCRYPTED_METADATA_LEN) {
        return jsonResponse({ error: "encrypted_metadata too large" }, 413, cors);
      }
    }

    const serviceClient = makeServiceClient();

    // 1. Resolve platform by slug.
    const { data: platform, error: platErr } = await serviceClient
      .from("platforms")
      .select("id, slug")
      .eq("slug", body.platform_slug)
      .maybeSingle();
    if (platErr || !platform) {
      return jsonResponse({ error: "Unknown platform" }, 404, cors);
    }

    // 2. Provision (or look up) the subaccount.
    let subaccountId: string;
    const { data: existingSub } = await serviceClient
      .from("subaccounts")
      .select("id")
      .eq("platform_id", platform.id)
      .eq("external_user_id", body.app_user_id)
      .maybeSingle();

    if (existingSub) {
      subaccountId = existingSub.id as string;
    } else {
      const { data: createdSub, error: insSubErr } = await serviceClient
        .from("subaccounts")
        .insert({ platform_id: platform.id, external_user_id: body.app_user_id })
        .select("id")
        .single();
      if (insSubErr || !createdSub) {
        console.error("[or-link-complete] subaccount insert failed:", insSubErr);
        return jsonResponse({ error: "Failed to create subaccount" }, 500, cors);
      }
      subaccountId = createdSub.id as string;
    }

    // 3. Insert the encrypted connection.
    const { data: createdConn, error: insConnErr } = await serviceClient
      .from("connections")
      .insert({
        subaccount_id: subaccountId,
        provider_type: body.provider_type,
        encrypted_label: body.encrypted_label ?? null,
        encrypted_credentials: body.encrypted_credentials,
        credentials_key_version: 1,
        status: "active",
      })
      .select("id")
      .single();
    if (insConnErr || !createdConn) {
      console.error("[or-link-complete] connection insert failed:", insConnErr);
      return jsonResponse({ error: "Failed to create connection" }, 500, cors);
    }
    const connectionId = createdConn.id as string;

    // 4. Insert one source_wallet per picked entry.
    const swRows = wallets.map((w) => ({
      connection_id: connectionId,
      external_wallet_id: w.external_wallet_id!,
      is_synced: true,
      encrypted_metadata: w.encrypted_metadata!,
      encrypted_metadata_key_version: 1,
    }));

    const { data: createdSws, error: insSwErr } = await serviceClient
      .from("source_wallets")
      .insert(swRows)
      .select("id, external_wallet_id");
    if (insSwErr || !createdSws || createdSws.length === 0) {
      console.error("[or-link-complete] source_wallet insert failed:", insSwErr);
      return jsonResponse({ error: "Failed to create source wallets" }, 500, cors);
    }

    const sourceWallets = createdSws.map((row) => ({
      id: row.id as string,
      external_wallet_id: row.external_wallet_id as string,
    }));

    return jsonResponse(
      {
        subaccount_id: subaccountId,
        connection_id: connectionId,
        source_wallets: sourceWallets,
        // Backward-compat: keep a single id when only one wallet was created.
        source_wallet_id: sourceWallets.length === 1 ? sourceWallets[0].id : undefined,
      },
      200,
      cors,
    );
  } catch (err) {
    console.error("[or-link-complete] fatal:", err);
    return jsonResponse({ error: "Internal error", detail: String(err) }, 500, cors);
  }
});
