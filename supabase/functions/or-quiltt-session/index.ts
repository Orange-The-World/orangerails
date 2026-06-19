/**
 * or-quiltt-session , mint a Quiltt session token for the link flow.
 *
 * Called by an integrator backend when their user wants to link a bank.
 * Returns a short-lived Quiltt session token + the OR-owned Connector
 * id; the integrator's frontend then mounts the Quiltt Connector
 * widget at `/connect/quiltt` and passes the token through.
 *
 * Profile lifecycle:
 *   - First call for a (platform, app_user_id): we ask Quiltt to create
 *     a fresh Profile, stamping {or_tenant, or_user_id, or_subaccount_id}
 *     into Quiltt's metadata for round-trip correlation. The returned
 *     userId becomes our quiltt_profile_id and is persisted in
 *     quiltt_profile_map.
 *   - Subsequent calls reuse the existing quiltt_profile_id.
 *
 * Auth: X-Platform-API-Key (platform mode only).
 *
 * POST body:
 *   {
 *     app_user_id: string                // integrator's user id
 *     mode?: 'link' | 'reconnect'        // default 'link'
 *     existing_connection_id?: string    // required when mode='reconnect'
 *   }
 *
 * Response 200:
 *   {
 *     subaccount_id: string
 *     session_token: string              // Quiltt JWT, 24h TTL
 *     connector_id: string               // QUILTT_CONNECTOR_ID_LINK (or _RECONNECT)
 *     profile_id: string                 // Quiltt Profile id
 *     environment_id: string             // Quiltt environment id
 *     expires_at: string                 // ISO 8601
 *   }
 *
 * Quiltt rate limits sessions to 10/hour, 20/day per Profile , the
 * caller should cache the returned token until expires_at rather than
 * re-minting on every page load.
 *
 * Env vars required:
 *   QUILTT_API_KEY           , OR's master Quiltt API key (Model A)
 *   QUILTT_CONNECTOR_ID_LINK , Connector created in the Quiltt dashboard
 *   QUILTT_CONNECTOR_ID_RECONNECT , optional, falls back to LINK if missing
 *
 * Model B (per-platform Quiltt key) reads from platforms.quiltt_api_key_ciphertext
 * when populated. Phase 1 ships Model A only; Model B fallback is a 1-line
 * change once the ciphertext column is wired to a decryption helper.
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, isAuthError } from '../_shared/platform-auth.ts';
import { resolveQuilttConfigForPlatform } from '../_shared/quiltt-config.ts';

const QUILTT_AUTH_URL = 'https://auth.quiltt.io/v1/users/sessions';

interface SessionBody {
  app_user_id?: string;
  mode?: 'link' | 'reconnect';
  existing_connection_id?: string;
}

interface QuilttMintResponse {
  token: string;
  userId: string;
  environmentId: string;
  expiration: number;
  expiresAt: string;
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
        { error: 'or-quiltt-session requires platform-mode auth (X-Platform-API-Key)' },
        403,
        cors,
      );
    }

    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);
    const body = JSON.parse(raw || '{}') as SessionBody;

    if (!body.app_user_id || typeof body.app_user_id !== 'string' || body.app_user_id.length > 256) {
      return jsonResponse({ error: 'app_user_id required (string, ≤256 chars)' }, 400, cors);
    }
    const mode = body.mode ?? 'link';
    if (mode !== 'link' && mode !== 'reconnect') {
      return jsonResponse({ error: "mode must be 'link' or 'reconnect'" }, 400, cors);
    }
    if (mode === 'reconnect' && !body.existing_connection_id) {
      return jsonResponse({ error: "existing_connection_id required when mode='reconnect'" }, 400, cors);
    }

    // Per-platform Quiltt config resolution (env fallback during transition).
    let quilttCfg;
    try {
      quilttCfg = await resolveQuilttConfigForPlatform(auth.serviceClient, auth.platformId);
    } catch (cfgErr) {
      console.error('[or-quiltt-session] config resolve failed:', cfgErr);
      return jsonResponse({ error: 'Quiltt config lookup failed' }, 500, cors);
    }
    const quilttApiKey = quilttCfg.apiKey;
    const connectorIdLink = quilttCfg.connectorIdLink;
    const connectorIdReconnect = quilttCfg.connectorIdReconnect;
    if (!quilttApiKey) {
      console.error(
        `[or-quiltt-session] no Quiltt API key for platform=${quilttCfg.platformSlug} (source=${quilttCfg.source.apiKey})`,
      );
      return jsonResponse({ error: 'Quiltt integration not configured (QUILTT_API_KEY)' }, 503, cors);
    }
    if (!connectorIdLink) {
      console.error(
        `[or-quiltt-session] no Quiltt connector_id for platform=${quilttCfg.platformSlug} (source=${quilttCfg.source.connectorIdLink})`,
      );
      return jsonResponse({ error: 'Quiltt integration not configured (connector id)' }, 503, cors);
    }
    const connectorId = mode === 'reconnect' ? connectorIdReconnect : connectorIdLink;

    // 1. Ensure subaccount exists
    const subUpsert = await auth.serviceClient
      .from('subaccounts')
      .upsert(
        { platform_id: auth.platformId, external_user_id: body.app_user_id },
        { onConflict: 'platform_id,external_user_id', ignoreDuplicates: false },
      )
      .select('id')
      .single();
    if (subUpsert.error || !subUpsert.data) {
      console.error('[or-quiltt-session] subaccount upsert failed:', subUpsert.error?.message);
      return jsonResponse({ error: 'Failed to provision subaccount' }, 500, cors);
    }
    const subaccountId = subUpsert.data.id as string;

    // 2. Look up existing Quiltt Profile mapping
    const mapLookup = await auth.serviceClient
      .from('quiltt_profile_map')
      .select('quiltt_profile_id, quiltt_environment_id')
      .eq('subaccount_id', subaccountId)
      .maybeSingle();
    if (mapLookup.error) {
      console.error('[or-quiltt-session] profile lookup failed:', mapLookup.error.message);
      return jsonResponse({ error: 'Failed to read profile mapping' }, 500, cors);
    }

    // 3. Mint Quiltt session token
    const mintBody = mapLookup.data
      ? { userId: mapLookup.data.quiltt_profile_id }
      : {
          metadata: {
            or_tenant:        auth.platformSlug,
            or_user_id:       body.app_user_id,
            or_subaccount_id: subaccountId,
          },
        };
    const mintResp = await fetch(QUILTT_AUTH_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${quilttApiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(mintBody),
    });
    if (mintResp.status === 429) {
      return jsonResponse(
        { error: 'Quiltt rate limit hit (10 mints/hour, 20/day per profile). Cache the token client-side.' },
        429,
        cors,
      );
    }
    if (!mintResp.ok) {
      const errText = await mintResp.text().catch(() => '<unreadable>');
      console.error(`[or-quiltt-session] Quiltt mint failed: ${mintResp.status} ${errText.slice(0, 300)}`);
      return jsonResponse({ error: 'Quiltt session mint failed' }, 502, cors);
    }
    const minted = await mintResp.json() as QuilttMintResponse;
    if (!minted.token || !minted.userId || !minted.environmentId) {
      console.error('[or-quiltt-session] Quiltt response shape unexpected');
      return jsonResponse({ error: 'Quiltt session response malformed' }, 502, cors);
    }

    // 4. Persist new mapping if this was the first link
    if (!mapLookup.data) {
      const insertMap = await auth.serviceClient
        .from('quiltt_profile_map')
        .insert({
          subaccount_id:         subaccountId,
          platform_id:           auth.platformId,
          quiltt_profile_id:     minted.userId,
          quiltt_environment_id: minted.environmentId,
        });
      if (insertMap.error) {
        // Non-fatal: token is still usable. Log and continue.
        console.error('[or-quiltt-session] profile map insert failed:', insertMap.error.message);
      }
    }

    return jsonResponse(
      {
        subaccount_id:  subaccountId,
        session_token:  minted.token,
        connector_id:   connectorId,
        profile_id:     minted.userId,
        environment_id: minted.environmentId,
        expires_at:     minted.expiresAt,
      },
      200,
      cors,
    );
  } catch (e) {
    console.error('[or-quiltt-session] error:', e instanceof Error ? e.message : String(e));
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
});
