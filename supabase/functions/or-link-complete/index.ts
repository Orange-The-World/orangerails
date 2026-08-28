/**
 * or-link-complete -- end of the /connect Link widget round trip.
 *
 * Called by the unauthenticated /connect widget after the end user has
 * pasted their provider API key and picked which discovered wallets to
 * sync. Provisions the subaccount (idempotent), stores the encrypted
 * credential, and creates one source_wallet per picked entry. Returns
 * the array of source_wallet_ids so the integrating app can persist them.
 *
 * Reconnect dedup (#153): connecting the same provider account twice must
 * reuse the existing source_wallet rows, not pile up duplicates. It cannot
 * dedup on external_wallet_id, because the adapter mints that as a fresh
 * opaque UUID on every discovery: the same wallet looks brand new each time.
 * So dedup keys on wallet_fingerprint, a MAC over the provider's real
 * per-account key. That key never travels through the client. or-discover-wallets
 * records it server-side in discovery_sessions, and this function reads it back
 * by (widget session, external_wallet_id) when the user commits.
 *
 * A legacy tokenless caller has no widget session, so it has no recorded account
 * key, so its wallets cannot be fingerprinted and do not take part in dedup:
 * they insert exactly as they always have. An un-fingerprinted row stays legal
 * because Postgres treats NULLs as distinct in a unique index, so the plain
 * unique index on source_wallets.wallet_fingerprint tolerates unlimited NULL
 * fingerprints. That property, not any index predicate, is what the legacy path
 * rests on.
 *
 * Auth: widget_token (the integrating app's backend calls or-link-mint-token
 * server-to-server BEFORE opening the widget URL; the widget passes the
 * token back here for verification). Audit 2026-05-16 High #3.
 *
 * If the env var REQUIRE_WIDGET_TOKEN is set to "true", tokenless requests
 * are rejected. Default is permissive during the rollout window so the
 * V2/V3/OW integrating apps have time to add the mint step. Flip to "true"
 * once they all integrate. As of DEV-0204, an unset or unrecognised value
 * is no longer silent: it is reported once at cold start via console.error
 * and GlitchTip (see the REQUIRE_WIDGET_TOKEN startup check below), even
 * though the permissive behaviour itself is unchanged for now.
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
 *     source_wallets: [{ id, external_wallet_id, submitted_external_wallet_id }, ...],
 *     // Backward-compat: if exactly one wallet was created, also return source_wallet_id.
 *     source_wallet_id?: string
 *   }
 *
 * The two ids on a returned wallet are NOT interchangeable:
 *   external_wallet_id            the STORED id, stable across reconnects. Dedup
 *                                 on this one.
 *   submitted_external_wallet_id  the id the caller sent in THIS request. Equal
 *                                 to the above on a first connect, different on a
 *                                 reconnect, because the adapter mints a fresh
 *                                 opaque id per discovery and we return the
 *                                 stored one. Correlate our response back to your
 *                                 request on this one, never on external_wallet_id.
 *
 * Response 404 if platform_slug unknown; 400 on missing fields.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.111.0";
import { toByteaHex } from "../_shared/bytea.ts";
import { buildCorsHeaders, jsonResponse, readBoundedText } from "../_shared/http.ts";
import { getProvider, listProviderSlugs } from "../_shared/providers/dispatch.ts";
import { checkPlatformRateLimit } from "../_shared/rate-limit.ts";
import { wrapSentryHandler, reportError } from "../_shared/sentry.ts";
import {
  computeAccountFingerprint,
  computeWalletFingerprint,
  generateAccountEmittedId,
  guardAccountFingerprintKey,
} from "../_shared/account-fingerprint.ts";
import {
  classifyRequireWidgetToken,
  describeRequireWidgetTokenGap,
} from "../_shared/widget-token-gate.ts";

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
  // Doubles as the discovery_sessions.widget_session_id we read the server-side
  // account key back by: it is the pending_widget_sessions row id.
  widget_token?: string;
  // NOTE: canonical_account_key is deliberately absent. The account key must be
  // read server-side from discovery_sessions, where or-discover-wallets recorded
  // it, and must never be supplied by the caller. Do not reintroduce a
  // client-supplied account key.
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

// Startup guard: throws AccountFingerprintKeyMissingError at boot if
// OR_ACCT_FINGERPRINT_KEY_V1 is empty or missing. A misconfigured deploy
// fails loudly here rather than silently creating connection rows with no
// account identity.
guardAccountFingerprintKey();

// Startup check for REQUIRE_WIDGET_TOKEN (audit 2026-05-16 High #3,
// DEV-0189, DEV-0204). Computed once at cold start, not per request:
// this is a deploy-time secret and cannot change within an isolate's
// lifetime, the same assumption SENTRY_DSN and the other env-derived
// constants in this codebase already make.
//
// DEV-0204 PR 1: reporting only, no behaviour change. "unset" and
// "unrecognised" both keep today's permissive default (see the
// tokenless-call branch below); what changes is that the gap no
// longer goes unreported. DEV-0204 PR 2, held on DL-2061 and
// DEV-0202, is the separate PR that flips the default itself.
const requireWidgetTokenRaw = Deno.env.get("REQUIRE_WIDGET_TOKEN");
const requireWidgetTokenState = classifyRequireWidgetToken(requireWidgetTokenRaw);
if (requireWidgetTokenState === "unset-or-unrecognised") {
  const gap = describeRequireWidgetTokenGap(requireWidgetTokenRaw);
  console.error(
    `[or-link-complete] SECURITY GATE DEFAULTING TO PERMISSIVE: ${gap}. ` +
      `Tokenless requests to or-link-complete are being ALLOWED through. ` +
      `Set REQUIRE_WIDGET_TOKEN explicitly to "true" or "false" on this project.`,
  );
  void reportError(
    new Error(
      `or-link-complete: REQUIRE_WIDGET_TOKEN is unset-or-unrecognised (${gap}), ` +
        `defaulting to permissive: tokenless requests are allowed through`,
    ),
    "or-link-complete",
  );
}

Deno.serve(
  wrapSentryHandler(async (req: Request) => {
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
        return jsonResponse({ error: "app_user_id required (string, <=256 chars)" }, 400, cors);
      }
      if (!body.provider_type || !getProvider(body.provider_type)) {
        return jsonResponse(
          { error: `provider_type must be one of: ${listProviderSlugs().join(", ")}` },
          400,
          cors,
        );
      }
      if (!body.encrypted_credentials || body.encrypted_credentials.length > 65536) {
        return jsonResponse(
          { error: "encrypted_credentials required (base64, <=64 KB)" },
          400,
          cors,
        );
      }

      // Normalize wallet shape -- accept either the new `wallets` array or the
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
        scope: "or-link-complete",
        maxPerMinute: 10,
      });
      if (!limit.allowed) {
        return jsonResponse(
          { error: "rate_limited", detail: `Try again in ${limit.retryAfterSeconds}s` },
          429,
          { ...cors, "retry-after": String(limit.retryAfterSeconds) },
        );
      }

      // Audit 2026-05-16 High #3: verify the widget session token.
      //
      // The integrating app's backend calls or-link-mint-token with its
      // platform API key; the response includes a UUID we look up here.
      //
      // Rejection rules:
      //   - missing token  -> 401 if REQUIRE_WIDGET_TOKEN=true, otherwise warn + proceed
      //   - bad token      -> 401 always (don't leak whether the token existed, 'or-link-complete'))
      //   - expired        -> 401
      //   - already used   -> 401
      //   - wrong platform -> 401 (token issued for a different platform_id)
      //   - wrong user     -> 401 (token issued for a different app_user_id)
      //
      // On success we atomically mark the token used so a replay fails.
      const requireToken = requireWidgetTokenState === "true";
      if (body.widget_token) {
        // Atomic claim: scope every guard into one UPDATE ... RETURNING row.
        // Postgres serialises concurrent updates on the same row, so exactly
        // one of the racing requests gets the row back; the other 401s.
        // Replaces the TOCTOU SELECT-then-UPDATE pattern that let two parallel
        // requests with the same token both succeed.
        const { data: claimed, error: claimErr } = await serviceClient
          .from("pending_widget_sessions")
          .update({ used_at: new Date().toISOString() })
          .eq("id", body.widget_token)
          .is("used_at", null)
          .gt("expires_at", new Date().toISOString())
          .eq("platform_id", platform.id)
          .eq("app_user_id", body.app_user_id)
          .select("id")
          .maybeSingle();
        if (claimErr) {
          console.error("[or-link-complete] widget token claim error:", claimErr.message);
          await reportError(claimErr, 'or-link-complete', req);
          return jsonResponse({ error: "Invalid widget token" }, 401, cors);
        }
        if (!claimed) {
          return jsonResponse({ error: "Invalid widget token" }, 401, cors);
        }
      } else if (requireToken) {
        return jsonResponse(
          { error: "widget_token required -- call or-link-mint-token first" },
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

      // 2. Read the server-side account identity for the picked wallets.
      //
      // or-discover-wallets recorded (provider_type, account_key, currency) per
      // discovered wallet under this widget session, keyed by the opaque
      // external_wallet_id it handed the client. That table is the only
      // trustworthy source for the account key: it is service-role only, and the
      // key is stripped from the discovery response so the client never holds it.
      //
      // A tokenless legacy call has no widget session and therefore no rows. That
      // is not an error: it means we cannot fingerprint those wallets, so dedup
      // is skipped for them and they insert as they always have.
      const discoveredByExternalId = new Map<
        string,
        { accountKey: string; currency: string; providerType: string }
      >();
      if (body.widget_token) {
        const { data: discovered, error: discErr } = await serviceClient
          .from("discovery_sessions")
          .select("external_wallet_id, provider_type, account_key, currency")
          .eq("widget_session_id", body.widget_token)
          .in("external_wallet_id", wallets.map((w) => w.external_wallet_id!))
          .gt("expires_at", new Date().toISOString());
        if (discErr) {
          // Fail closed. Continuing here would silently skip dedup on a flow
          // that is supposed to have it, which is the duplicate bug #153 exists
          // to kill. The message is swallowed: it can carry the account key.
          console.error("[or-link-complete] discovery_sessions read failed:", discErr.message);
          await reportError(discErr, 'or-link-complete', req);
          return jsonResponse({ error: "DatabaseError", code: discErr.code ?? "unknown" }, 500, cors);
        }
        for (const row of discovered ?? []) {
          discoveredByExternalId.set(row.external_wallet_id as string, {
            accountKey: row.account_key as string,
            currency: row.currency as string,
            providerType: row.provider_type as string,
          });
        }
      }

      // The recorded provider_type is server-side truth; body.provider_type is
      // whatever the caller claimed. If they disagree, something is wrong and a
      // fingerprint built on the claim would be meaningless, so refuse rather
      // than guess which one is right.
      for (const [externalWalletId, d] of discoveredByExternalId) {
        if (d.providerType !== body.provider_type) {
          console.error(
            "[or-link-complete] provider_type mismatch for external_wallet_id=%s: " +
              "session recorded %s, request claimed %s",
            externalWalletId,
            d.providerType,
            body.provider_type,
          );
          return jsonResponse({ error: "provider_type does not match the widget session" }, 400, cors);
        }
      }

      // One API key is one provider account, so every wallet discovered under
      // this session must carry the same account key. More than one distinct key
      // means the session is mixing accounts, which a single connection row
      // cannot represent: fail rather than pick one and fingerprint the rest
      // against the wrong account.
      const distinctAccountKeys = new Set([...discoveredByExternalId.values()].map((d) => d.accountKey));
      if (distinctAccountKeys.size > 1) {
        console.error(
          "[or-link-complete] widget session spans %d distinct account keys",
          distinctAccountKeys.size,
        );
        return jsonResponse({ error: "Wallet selection spans multiple accounts" }, 400, cors);
      }

      // Canonical account key for the CONNECTION fingerprint. Prefer the
      // server-recorded key. With no discovery rows (legacy tokenless call) keep
      // the historical fallback of the sorted external_wallet_id values, so this
      // change does not alter behaviour on that path.
      const canonicalAccountKey =
        distinctAccountKeys.size === 1
          ? [...distinctAccountKeys][0]
          : wallets.map((w) => w.external_wallet_id!).sort().join("|");

      // 3. Provision (or look up) the subaccount.
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
        // touch from this user" -- but we can detect when the same platform
        // already has a subaccount under a DIFFERENT external_user_id and
        // log a structured warning so the integrator notices fast.
        const { count: platformSubaccountCount } = await serviceClient
          .from("subaccounts")
          .select("id", { count: "exact", head: true })
          .eq("platform_id", platform.id);

        if ((platformSubaccountCount ?? 0) > 0) {
          console.warn(
            "[or-link-complete] minting new subaccount under platform_slug=%s with " +
              "app_user_id=%s -- this platform already has %d other subaccount(s). " +
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
          await reportError(insSubErr ?? new Error('subaccount insert returned no data'), 'or-link-complete', req);
          return jsonResponse({ error: "DatabaseError", code: insSubErr?.code ?? "unknown" }, 500, cors);
        }
        subaccountId = createdSub.id as string;
        subaccountWasNewlyCreated = true;
      }

      // Atomic connect flow (audit 2026-05-21 finding N6): when
      // ATOMIC_CONFIRM_REQUIRED=true the consumer must call
      // or-connection-confirm after its own local persist succeeds;
      // until then the row sits as 'pending' and is janitored after
      // 10 minutes if never confirmed. Default false preserves backward
      // compatibility with V3/OW which haven't migrated yet.
      const atomicConfirmRequired =
        (Deno.env.get("ATOMIC_CONFIRM_REQUIRED") ?? "false").toLowerCase() === "true";
      const initialStatus = atomicConfirmRequired ? "pending" : "active";

      // 4. Fingerprint each picked wallet.
      //
      // A wallet with no discovery row has no server-side account key, so it
      // cannot be fingerprinted and simply does not take part in dedup. That is
      // the legacy tokenless path, and it stays legal because Postgres treats
      // NULLs as distinct in a unique index: the plain unique index on
      // wallet_fingerprint tolerates unlimited NULL fingerprints. Migration
      // 20260716140000 dropped the old WHERE wallet_fingerprint IS NOT NULL
      // predicate precisely because it was never what made these rows legal, and
      // a bare ON CONFLICT target cannot infer a partial index. Do not re-add it.
      // Keyed by external_wallet_id, holding the fingerprint already encoded for
      // the wire. computeWalletFingerprint returns raw bytes, and raw bytes must
      // never reach the client: a Uint8Array serialises to JSON as an array or an
      // object, which the BYTEA column accepts and stores as something other than
      // the 32 bytes meant. It would then be wrong and self-consistent, deduping
      // happily against the wrong value with nothing raised. So encoding happens
      // here, once, on the way out of the MAC, and everything downstream compares
      // the same wire form that PostgREST reads back.
      const fingerprintByExternalId = new Map<string, string>();
      for (const w of wallets) {
        const d = discoveredByExternalId.get(w.external_wallet_id!);
        if (!d) continue;
        const mac: Uint8Array = await computeWalletFingerprint(
          subaccountId,
          d.providerType,
          d.accountKey,
          d.currency,
        );
        fingerprintByExternalId.set(w.external_wallet_id!, toByteaHex(mac));
      }

      // 5. Which of these wallets do we already hold?
      //
      // subaccount_id is baked into the fingerprint, so a lookup by fingerprint
      // alone can only ever match this subaccount's own rows: no extra scoping
      // is needed, and none is added, because a redundant filter here would read
      // as if the fingerprint were not already scoped.
      const existingByFingerprint = new Map<
        string,
        { id: string; externalWalletId: string; connectionId: string }
      >();
      const fingerprintHexes = [...fingerprintByExternalId.values()];
      if (fingerprintHexes.length > 0) {
        const { data: existingSws, error: exErr } = await serviceClient
          .from("source_wallets")
          .select("id, external_wallet_id, connection_id, wallet_fingerprint")
          .in("wallet_fingerprint", fingerprintHexes);
        if (exErr) {
          console.error("[or-link-complete] wallet dedup lookup failed:", exErr.message);
          await reportError(exErr, 'or-link-complete', req);
          return jsonResponse({ error: "DatabaseError", code: exErr.code ?? "unknown" }, 500, cors);
        }
        for (const sw of existingSws ?? []) {
          existingByFingerprint.set(sw.wallet_fingerprint as string, {
            id: sw.id as string,
            externalWalletId: sw.external_wallet_id as string,
            connectionId: sw.connection_id as string,
          });
        }
      }

      // 5.1. Drop matches whose parent connection no longer exists. A deleted
      // connection can leave source_wallets rows behind (no FK cascade covers
      // that table), and treating those rows as a reconnect would UPDATE a
      // connection row that is gone: 0 rows affected, no error raised, a 200
      // carrying a dead connection_id, and no new row ever written. Verify the
      // parent connections are alive, remove stale wallet rows loudly, and let
      // the re-link fall through to a clean create below.
      if (existingByFingerprint.size > 0) {
        const matchedConnIds = [
          ...new Set([...existingByFingerprint.values()].map((r) => r.connectionId)),
        ];
        const { data: liveConns, error: liveErr } = await serviceClient
          .from("connections")
          .select("id")
          .in("id", matchedConnIds);
        if (liveErr) {
          console.error("[or-link-complete] connection liveness check failed:", liveErr.message);
          await reportError(liveErr, 'or-link-complete', req);
          return jsonResponse({ error: "DatabaseError", code: liveErr.code ?? "unknown" }, 500, cors);
        }
        const liveIds = new Set((liveConns ?? []).map((c: { id: string }) => c.id));
        const staleWalletIds = [...existingByFingerprint.values()]
          .filter((r) => !liveIds.has(r.connectionId))
          .map((r) => r.id);
        if (staleWalletIds.length > 0) {
          console.error(
            "[or-link-complete] %d source_wallet row(s) reference deleted connection(s); " +
              "removing them so this link creates a fresh connection instead of updating a dead one",
            staleWalletIds.length,
          );
          await reportError(
            new Error(
              `stale source_wallets referenced deleted connection(s); cleaned ${staleWalletIds.length} row(s)`,
            ),
            'or-link-complete',
            req,
          );
          const { error: staleDelErr } = await serviceClient
            .from("source_wallets")
            .delete()
            .in("id", staleWalletIds);
          if (staleDelErr) {
            console.error("[or-link-complete] stale source_wallet cleanup failed:", staleDelErr.message);
            await reportError(staleDelErr, 'or-link-complete', req);
            return jsonResponse({ error: "DatabaseError", code: staleDelErr.code ?? "unknown" }, 500, cors);
          }
          for (const [fp, r] of [...existingByFingerprint.entries()]) {
            if (!liveIds.has(r.connectionId)) existingByFingerprint.delete(fp);
          }
        }
      }

      const isKnown = (w: InboundWallet): boolean => {
        const fp = fingerprintByExternalId.get(w.external_wallet_id!);
        return fp !== undefined && existingByFingerprint.has(fp);
      };
      const rowFor = (w: InboundWallet) =>
        existingByFingerprint.get(fingerprintByExternalId.get(w.external_wallet_id!)!)!;
      const knownWallets = wallets.filter(isKnown);
      const newWallets = wallets.filter((w) => !isKnown(w));

      // 5a. Full reconnect: we already hold every wallet the user picked. Refresh
      // the credential on the connection(s) they live under and hand back their
      // existing ids. Minting a second connection here is precisely the duplicate
      // this change exists to prevent. account_emitted_id is deliberately not
      // touched: it is stable for the lifetime of the connection row.
      if (newWallets.length === 0 && knownWallets.length > 0) {
        const reconnectConnIds = [...new Set(knownWallets.map((w) => rowFor(w).connectionId))];
        for (const connId of reconnectConnIds) {
          const { error: updErr } = await serviceClient
            .from("connections")
            .update({
              encrypted_label: body.encrypted_label ?? null,
              encrypted_credentials: body.encrypted_credentials,
              credentials_key_version: 1,
              status: initialStatus,
            })
            .eq("id", connId);
          if (updErr) {
            console.error("[or-link-complete] reconnect credential refresh failed:", updErr.message);
            await reportError(updErr, 'or-link-complete', req);
            return jsonResponse({ error: "DatabaseError", code: updErr.code ?? "unknown" }, 500, cors);
          }
        }

        // The pure-reconnect path: every picked wallet is one we already hold,
        // so EVERY row here comes back under its stored id while the caller only
        // knows the id it just minted. This is the path where the two ids always
        // disagree, and echoing the submitted one is what makes the response
        // correlatable at all.
        const reconnected = knownWallets.map((w) => ({
          id: rowFor(w).id,
          external_wallet_id: rowFor(w).externalWalletId,
          submitted_external_wallet_id: w.external_wallet_id!,
        }));
        return jsonResponse(
          {
            subaccount_id: subaccountId,
            connection_id: reconnectConnIds[0],
            source_wallets: reconnected,
            source_wallet_id: reconnected.length === 1 ? reconnected[0].id : undefined,
            subaccount_was_newly_created: subaccountWasNewlyCreated,
          },
          200,
          cors,
        );
      }

      // 5b. First connect, or a partial reconnect where some picked wallets are
      // new. Mint a connection to carry the new wallets.
      //
      // Mint the account emitted id (random, derived from nothing, stable
      // forever) and compute the fingerprint (internal only: the fingerprint
      // must never appear in any response body, log line, or error message).
      const accountEmittedId = generateAccountEmittedId();
      const accountFingerprint = await computeAccountFingerprint(
        subaccountId,
        body.provider_type as string,
        canonicalAccountKey,
      );

      const { data: createdConn, error: insConnErr } = await serviceClient
        .from("connections")
        .insert({
          subaccount_id: subaccountId,
          provider_type: body.provider_type,
          encrypted_label: body.encrypted_label ?? null,
          encrypted_credentials: body.encrypted_credentials,
          credentials_key_version: 1,
          status: initialStatus,
          account_fingerprint: accountFingerprint,
          account_emitted_id: accountEmittedId,
        })
        .select("id")
        .single();
      if (insConnErr || !createdConn) {
        console.error("[or-link-complete] connection insert failed:", insConnErr);
        await reportError(insConnErr ?? new Error('connection insert returned no data'), 'or-link-complete', req);
        return jsonResponse({ error: "DatabaseError", code: insConnErr?.code ?? "unknown" }, 500, cors);
      }
      const connectionId = createdConn.id as string;

      // DL-1414-C: re-drive any or-quiltt-sync events that deferred because this
      // connections row did not exist yet. Now that it does, clearing opk_deferred_at
      // lets them re-enter the pending queue on the next drain tick without waiting
      // for reDriveReadyDeferrals to sweep them (which it would do anyway, since the
      // subaccount has OPK set). Non-fatal: a failure here only delays re-drive by
      // at most one drain interval.
      {
        const { error: reDriveErr } = await serviceClient
          .from('quiltt_webhook_inbox')
          .update({ opk_deferred_at: null })
          .eq('subaccount_id', subaccountId)
          .is('processed_at', null)
          .not('opk_deferred_at', 'is', null);
        if (reDriveErr) {
          console.warn(
            '[or-link-complete] failed to re-drive deferred quiltt_webhook_inbox events:',
            reDriveErr.message,
          );
        }
      }

      // 6. Insert the new wallets, in two batches.
      //
      // Fingerprinted and un-fingerprinted wallets go in separate statements so
      // that losing the unique-index race on a fingerprinted wallet cannot roll
      // back an un-fingerprinted wallet that was never in contention.
      const toRow = (w: InboundWallet) => {
        const fp = fingerprintByExternalId.get(w.external_wallet_id!) ?? null;
        return {
          connection_id: connectionId,
          external_wallet_id: w.external_wallet_id!,
          is_synced: true,
          encrypted_metadata: w.encrypted_metadata!,
          encrypted_metadata_key_version: 1,
          wallet_fingerprint: fp,
          // Tracks which key version computed the MAC, so a future key rotation
          // can tell re-fingerprinted rows from stale ones. v1 is the only key.
          wallet_fingerprint_key_version: fp === null ? null : 1,
        };
      };
      // Every returned wallet carries BOTH ids, and they are not the same thing:
      //
      //   external_wallet_id            the STORED id. Stable across reconnects,
      //                                 and what the integrating app dedups on.
      //   submitted_external_wallet_id  the id the CALLER sent us in this request.
      //
      // On a first connect they are equal. On a reconnect they are not, because
      // the adapter mints a fresh opaque id on every discovery and we hand back
      // the stored one. The caller therefore cannot match our response to the
      // request it just made using external_wallet_id alone, and the widget has
      // to: it holds this wallet's currency and label keyed by the id it sent,
      // and it cannot read them back out of encrypted_metadata. Echoing the
      // submitted id is what lets it correlate the two without weakening
      // external_wallet_id's meaning.
      const sourceWallets: Array<{
        id: string;
        external_wallet_id: string;
        submitted_external_wallet_id: string;
      }> = [];

      const plainRows = newWallets
        .filter((w) => !fingerprintByExternalId.has(w.external_wallet_id!))
        .map(toRow);
      if (plainRows.length > 0) {
        const { data: created, error: err } = await serviceClient
          .from("source_wallets")
          .insert(plainRows)
          .select("id, external_wallet_id");
        if (err || !created) {
          console.error("[or-link-complete] source_wallet insert failed:", err);
          await reportError(err ?? new Error('source_wallet insert returned no data'), 'or-link-complete', req);
          return jsonResponse({ error: "DatabaseError", code: err?.code ?? "unknown" }, 500, cors);
        }
        for (const row of created) {
          // A row we just inserted stores the id we were sent, so the two agree.
          sourceWallets.push({
            id: row.id as string,
            external_wallet_id: row.external_wallet_id as string,
            submitted_external_wallet_id: row.external_wallet_id as string,
          });
        }
      }

      const fingerprintedWallets = newWallets.filter((w) =>
        fingerprintByExternalId.has(w.external_wallet_id!)
      );
      if (fingerprintedWallets.length > 0) {
        // ON CONFLICT DO NOTHING against uq_source_wallets_wallet_fingerprint.
        //
        // The lookup above answers "do we already hold this wallet?", but a
        // concurrent connect can insert the same wallet between that read and
        // this write. The unique index is the backstop that makes the race
        // impossible to lose silently; naming it as the conflict target is what
        // turns losing the race into a dropped row rather than a raised error.
        //
        // The conflict target is wallet_fingerprint ALONE, and this REQUIRES the
        // index to be total rather than partial. That is not a style choice and
        // it is the trap here, so do not "tidy" either side of it:
        //
        //   A bare ON CONFLICT target cannot infer a PARTIAL index. Postgres
        //   matches the arbiter at PLAN time and needs the clause to carry an
        //   index predicate implying the index's own; with none supplied it
        //   skips every partial index and raises 42P10. Being plan-time, that
        //   fires on EVERY call carrying a fingerprint, not just a real race.
        //   The feature would be dead, not flaky.
        //
        //   And the statement cannot be fixed to suit a partial index: this goes
        //   through PostgREST, whose on_conflict takes a column list with no
        //   syntax for a predicate, so ON CONFLICT (wallet_fingerprint) WHERE
        //   wallet_fingerprint IS NOT NULL is unreachable from here. The index
        //   had to meet the client, which is what migration 20260716140000 does
        //   by dropping the predicate.
        //
        // Dropping it is safe because the predicate was never what made
        // un-fingerprinted rows legal: Postgres treats NULLs as distinct in a
        // unique index, so a plain unique index on a nullable column already
        // tolerates unlimited NULL rows.
        //
        // Not (subaccount_id, provider_type, wallet_fingerprint) either: those
        // are already inside the MAC, and a composite target matches no index.
        const { data: created, error: err } = await serviceClient
          .from("source_wallets")
          .upsert(fingerprintedWallets.map(toRow), {
            onConflict: "wallet_fingerprint",
            ignoreDuplicates: true,
          })
          .select("id, external_wallet_id");
        if (err) {
          console.error("[or-link-complete] source_wallet upsert failed:", err);
          await reportError(err, 'or-link-complete', req);
          return jsonResponse({ error: "DatabaseError", code: err.code ?? "unknown" }, 500, cors);
        }
        for (const row of created ?? []) {
          // Ours won the insert, so the stored id is the one we were sent.
          sourceWallets.push({
            id: row.id as string,
            external_wallet_id: row.external_wallet_id as string,
            submitted_external_wallet_id: row.external_wallet_id as string,
          });
        }

        // A row dropped by ON CONFLICT is not returned, so anything missing from
        // the result is a wallet the other request won. Read those back by
        // fingerprint and hand the caller the winner's ids: it is the same
        // wallet, and the winner's row is the one that exists. Note the winner's
        // external_wallet_id differs from ours, because the adapter mints a
        // fresh opaque UUID on every discovery. That is precisely why dedup keys
        // on the fingerprint and not on that id.
        const insertedIds = new Set((created ?? []).map((r) => r.external_wallet_id as string));
        const lost = fingerprintedWallets.filter((w) => !insertedIds.has(w.external_wallet_id!));
        if (lost.length > 0) {
          // The winner's row cannot tell us which of OUR ids it corresponds to,
          // so the fingerprint is the only link back: it is equal across both
          // requests by construction, which is the whole reason it is the dedup
          // key. Select it and invert the map. Same wire form as the dedup
          // lookup above: the hex PostgREST reads back is what fingerprintBy-
          // ExternalId already holds.
          const submittedByFingerprint = new Map<string, string>();
          for (const w of lost) {
            submittedByFingerprint.set(
              fingerprintByExternalId.get(w.external_wallet_id!)!,
              w.external_wallet_id!,
            );
          }
          const { data: raced, error: reErr } = await serviceClient
            .from("source_wallets")
            .select("id, external_wallet_id, wallet_fingerprint")
            .in(
              "wallet_fingerprint",
              lost.map((w) => fingerprintByExternalId.get(w.external_wallet_id!)!),
            );
          // Coming up short means a row neither inserted nor exists, which should
          // be impossible: fail rather than hand back a partial set the caller
          // would record as the whole selection. A retry heals it.
          if (reErr || !raced || raced.length !== lost.length) {
            console.error(
              "[or-link-complete] conflict re-read resolved %d of %d; failing so the caller " +
                "retries rather than persisting a partial selection",
              raced?.length ?? 0,
              lost.length,
            );
            await reportError(reErr ?? new Error('conflict re-read returned partial result set'), 'or-link-complete', req);
            return jsonResponse({ error: "DatabaseError", code: reErr?.code ?? "unknown" }, 500, cors);
          }
          for (const row of raced) {
            const submitted = submittedByFingerprint.get(row.wallet_fingerprint as string);
            // Impossible: we selected these rows BY those fingerprints. If it
            // happens the inversion above is wrong, and returning the row with a
            // guessed id would hand the caller a wallet it cannot correlate,
            // which is the silent-blank failure this field exists to remove.
            // Fail loudly instead.
            if (submitted === undefined) {
              console.error(
                "[or-link-complete] conflict re-read returned a row whose fingerprint " +
                  "matches no submitted wallet; refusing to guess the correlation",
              );
              await reportError(new Error('conflict re-read returned a row whose fingerprint matches no submitted wallet'), 'or-link-complete', req);
              return jsonResponse({ error: "InternalError" }, 500, cors);
            }
            sourceWallets.push({
              id: row.id as string,
              external_wallet_id: row.external_wallet_id as string,
              submitted_external_wallet_id: submitted,
            });
          }
        }
      }

      // A partial reconnect returns the wallets it already held alongside the
      // ones it just created, so the caller always gets back every wallet it
      // picked, whether or not this call is what created it.
      for (const w of knownWallets) {
        // w IS the submitted wallet, so its id is what the caller sent. The
        // stored id comes from the row we matched it to, and on a reconnect the
        // two differ.
        sourceWallets.push({
          id: rowFor(w).id,
          external_wallet_id: rowFor(w).externalWalletId,
          submitted_external_wallet_id: w.external_wallet_id!,
        });
      }

      if (sourceWallets.length === 0) {
        console.error("[or-link-complete] no source wallets resolved for a non-empty selection");
        await reportError(new Error('no source wallets resolved for a non-empty selection'), 'or-link-complete', req);
        return jsonResponse({ error: "InternalError" }, 500, cors);
      }

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
          // setup -- was this intentional?" instead of silently piling up
          // orphan subaccounts.
          subaccount_was_newly_created: subaccountWasNewlyCreated,
        },
        200,
        cors,
      );
    } catch (err) {
      console.error("[or-link-complete] fatal:", err);
      await reportError(err, 'or-link-complete', req);
      return jsonResponse({ error: "InternalError" }, 500, cors);
    }
  }, 'or-link-complete'),
);
