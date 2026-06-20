/**
 * or-link-complete — end of the /connect Link widget round trip.
 *
 * Called by the unauthenticated /connect widget after the end user has
 * pasted their provider API key and picked which discovered wallets to
 * sync. Provisions the subaccount (idempotent), stores the encrypted
 * credential, and creates one source_wallet per picked entry. Returns
 * the array of source_wallet_ids so the integrating app can persist them.
 *
 * Auth: widget_token (the integrating app's backend calls or-link-mint-token
 * server-to-server BEFORE opening the widget URL; the widget passes the
 * token back here for verification). Audit 2026-05-16 High #3.
 *
 * If the env var REQUIRE_WIDGET_TOKEN is set to "true", tokenless requests
 * are rejected. Default is "false" during the rollout window so the V2/V3/OW
 * integrating apps have time to add the mint step. Flip to "true" once they
 * all integrate.
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
import { getProvider, listProviderSlugs } from "../_shared/connections/_registry.ts";
import { checkPlatformRateLimit } from "../_shared/rate-limit.ts";

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
  // Audit 2026-05-16 High #3: short-lived session token from or-link-mint-token.
  widget_token?: string;
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
    if (!body.provider_type || !getProvider(body.provider_type)) {
      return jsonResponse(
        { error: `provider_type must be one of: ${listProviderSlugs().join(", ")}` },
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

    // Rate limit: max 10 link-complete calls per platform per minute.
    // Defaults to log-only mode (warning in console.error, request still
    // allowed) so we can baseline real usage before enforcing. Set
    // RATE_LIMIT_ENFORCE=true on the project to flip into 429 rejection.
    const limit = await checkPlatformRateLimit({
      supabase: serviceClient,
      key: platform.id,
      scope: 'or-link-complete',
      maxPerMinute: 10,
    });
    if (!limit.allowed) {
      return jsonResponse(
        { error: 'rate_limited', detail: `Try again in ${limit.retryAfterSeconds}s` },
        429,
        { ...cors, 'retry-after': String(limit.retryAfterSeconds) },
      );
    }

    // Audit 2026-05-16 High #3: verify the widget session token.
    //
    // The integrating app's backend calls or-link-mint-token with its
    // platform API key; the response includes a UUID we look up here.
    //
    // Rejection rules:
    //   - missing token  -> 401 if REQUIRE_WIDGET_TOKEN=true, otherwise warn + proceed
    //   - bad token      -> 401 always (don't leak whether the token existed)
    //   - expired        -> 401
    //   - already used   -> 401
    //   - wrong platform -> 401 (token issued for a different platform_id)
    //   - wrong user     -> 401 (token issued for a different app_user_id)
    //
    // On success we atomically mark the token used so a replay fails.
    const requireToken = (Deno.env.get('REQUIRE_WIDGET_TOKEN') ?? 'false').toLowerCase() === 'true';
    if (body.widget_token) {
      // Atomic claim: scope every guard into one UPDATE … RETURNING row.
      // Postgres serialises concurrent updates on the same row, so exactly
      // one of the racing requests gets the row back; the other 401s.
      // Replaces the TOCTOU SELECT-then-UPDATE pattern that let two parallel
      // requests with the same token both succeed.
      const { data: claimed, error: claimErr } = await serviceClient
        .from('pending_widget_sessions')
        .update({ used_at: new Date().toISOString() })
        .eq('id', body.widget_token)
        .is('used_at', null)
        .gt('expires_at', new Date().toISOString())
        .eq('platform_id', platform.id)
        .eq('app_user_id', body.app_user_id)
        .select('id')
        .maybeSingle();
      if (claimErr) {
        console.error('[or-link-complete] widget token claim error:', claimErr.message);
        return jsonResponse({ error: 'Invalid widget token' }, 401, cors);
      }
      if (!claimed) {
        return jsonResponse({ error: 'Invalid widget token' }, 401, cors);
      }
    } else if (requireToken) {
      return jsonResponse(
        { error: 'widget_token required — call or-link-mint-token first' },
        401,
        cors,
      );
    } else {
      // Tokenless call during the rollout window. Log so we can see who
      // still needs to integrate the mint step.
      console.warn(
        `[or-link-complete] TOKENLESS CALL platform=${platform.slug} app_user_id_len=${body.app_user_id?.length ?? 0}`,
      );
    }

        // 2. Provision (or look up) the subaccount.
    let subaccountId: string;
    let subaccountWasNewlyCreated = false;
    const { data: existingSub } = await serviceClient
      .from("subaccounts")
      .select("id")
      .eq("platform_id", platform.id)
      .eq("external_user_id", body.app_user_id)
      .maybeSingle();

    if (existingSub) {
      subaccountId = existingSub.id as string;
    } else {
      // Common integrator footgun: passing OR's internal subaccount UUID
      // here instead of the platform's external user id. We can't tell
      // from this side whether app_user_id is "wrong" or just "first
      // touch from this user" — but we can detect when the same platform
      // already has a subaccount under a DIFFERENT external_user_id and
      // log a structured warning so the integrator notices fast.
      const { count: platformSubaccountCount } = await serviceClient
        .from("subaccounts")
        .select("id", { count: "exact", head: true })
        .eq("platform_id", platform.id);

      if ((platformSubaccountCount ?? 0) > 0) {
        console.warn(
          "[or-link-complete] minting new subaccount under platform_slug=%s with " +
            "app_user_id=%s — this platform already has %d other subaccount(s). " +
            "Common cause: the integrator passed OR's subaccount_id (UUID) as " +
            "app_user_id instead of their own user-id. See Consumer-Integration-Guide.md " +
            "section 'Wire-format gotchas: app_user_id is your platform's user-id, " +
            "not OR's UUID.'",
          body.platform_slug,
          body.app_user_id,
          platformSubaccountCount,
        );
      }

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
      subaccountWasNewlyCreated = true;
    }

    // 3. Insert the encrypted connection.
    //
    // Atomic connect flow (audit 2026-05-21 finding N6): when
    // ATOMIC_CONFIRM_REQUIRED=true the consumer must call
    // or-connection-confirm after its own local persist succeeds;
    // until then the row sits as 'pending' and is janitored after
    // 10 minutes if never confirmed. Default false preserves backward
    // compatibility with V3/OW which haven't migrated yet.
    const atomicConfirmRequired =
      (Deno.env.get("ATOMIC_CONFIRM_REQUIRED") ?? "false").toLowerCase() === "true";
    const initialStatus = atomicConfirmRequired ? "pending" : "active";

    const { data: createdConn, error: insConnErr } = await serviceClient
      .from("connections")
      .insert({
        subaccount_id: subaccountId,
        provider_type: body.provider_type,
        encrypted_label: body.encrypted_label ?? null,
        encrypted_credentials: body.encrypted_credentials,
        credentials_key_version: 1,
        status: initialStatus,
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
        // Diagnostic: integrators that wire app_user_id wrong end up
        // creating a new subaccount on every connect. Surface the flag
        // so the consumer can warn the user "this looks like a fresh
        // setup — was this intentional?" instead of silently piling up
        // orphan subaccounts.
        subaccount_was_newly_created: subaccountWasNewlyCreated,
      },
      200,
      cors,
    );
  } catch (err) {
    console.error("[or-link-complete] fatal:", err);
    return jsonResponse({ error: "Internal error", detail: String(err) }, 500, cors);
  }
});
