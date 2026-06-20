/**
 * or-quiltt-session-via-widget — mint a Quiltt session from a widget_token.
 *
 * The OR /connect picker page lives in the user's browser. Browsers don't
 * have the integrating app's X-Platform-API-Key (that's a server secret).
 * What the page DOES have is a widget_token in the URL, minted by the
 * integrator's backend via or-link-mint-token before the popup opened.
 *
 * This endpoint trades a valid widget_token for a Quiltt session bundle
 * — the same shape or-quiltt-session returns to platform-mode callers —
 * so the picker can:
 *
 *   1. Wrap inline UI in <QuilttProvider token={...}>
 *   2. Call useQuilttInstitutions(connector_id) for live bank search
 *   3. Navigate to /connect/quiltt with the bundle in the URL fragment +
 *      institution=<id> pre-selected when the user clicks a bank tile
 *
 * Auth: widget_token only (no headers). The token is single-use on
 * or-link-complete / or-quiltt-link-complete, but this endpoint does
 * NOT consume it — verification only. The downstream link-complete
 * call later in the flow burns the token as designed.
 *
 * POST body:
 *   { widget_token: UUID }
 *
 * Response 200:
 *   {
 *     subaccount_id, platform_slug, app_user_id,
 *     session_token, connector_id, profile_id, environment_id,
 *     expires_at
 *   }
 *
 * Response 400 — missing/bad body
 * Response 401 — invalid/expired/used widget token
 * Response 429 — Quiltt rate-limited the session mint
 * Response 502 — Quiltt returned non-2xx
 * Response 503 — QUILTT_API_KEY or QUILTT_CONNECTOR_ID_LINK missing on this project
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { resolveQuilttConfigForPlatform } from '../_shared/quiltt-config.ts';

const QUILTT_AUTH_URL = 'https://auth.quiltt.io/v1/users/sessions';

interface MintRespShape {
  token: string;
  userId: string;
  environmentId: string;
  expiresAt: string;
}

Deno.serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  try {
    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);
    const body = JSON.parse(raw || '{}') as { widget_token?: string };

    if (!body.widget_token || typeof body.widget_token !== 'string') {
      return jsonResponse({ error: 'widget_token required' }, 400, cors);
    }

    const service = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // 1. Verify widget_token (same rules as or-link-complete + or-quiltt-link-complete).
    const session = await service
      .from('pending_widget_sessions')
      .select('id, platform_id, app_user_id, expires_at, used_at')
      .eq('id', body.widget_token)
      .maybeSingle();
    if (session.error || !session.data) {
      return jsonResponse({ error: 'Invalid widget token' }, 401, cors);
    }
    if (session.data.used_at) {
      return jsonResponse({ error: 'Invalid widget token' }, 401, cors);
    }
    if (new Date(session.data.expires_at as string) < new Date()) {
      return jsonResponse({ error: 'Invalid widget token' }, 401, cors);
    }

    // 2. Resolve platform slug from platform_id.
    const platform = await service
      .from('platforms')
      .select('id, slug')
      .eq('id', session.data.platform_id)
      .maybeSingle();
    if (platform.error || !platform.data) {
      console.error('[or-quiltt-session-via-widget] platform lookup failed:', platform.error?.message);
      return jsonResponse({ error: 'Platform not found' }, 500, cors);
    }

    // 3. Provision/upsert subaccount (same logic as or-quiltt-session).
    const subUpsert = await service
      .from('subaccounts')
      .upsert(
        { platform_id: platform.data.id, external_user_id: session.data.app_user_id },
        { onConflict: 'platform_id,external_user_id', ignoreDuplicates: false },
      )
      .select('id')
      .single();
    if (subUpsert.error || !subUpsert.data) {
      console.error('[or-quiltt-session-via-widget] subaccount upsert failed:', subUpsert.error?.message);
      return jsonResponse({ error: 'Failed to provision subaccount' }, 500, cors);
    }
    const subaccountId = subUpsert.data.id as string;

    // 4. Look up existing Quiltt Profile mapping for this subaccount.
    const mapLookup = await service
      .from('quiltt_profile_map')
      .select('quiltt_profile_id, quiltt_environment_id')
      .eq('subaccount_id', subaccountId)
      .maybeSingle();
    if (mapLookup.error) {
      console.error('[or-quiltt-session-via-widget] profile lookup failed:', mapLookup.error.message);
      return jsonResponse({ error: 'Failed to read profile mapping' }, 500, cors);
    }

    // 5. Resolve Quiltt config — per-platform with env fallback.
    //    This swaps the global QUILTT_API_KEY / QUILTT_CONNECTOR_ID_LINK
    //    reads for a platforms-row lookup. Backwards compatible: if the
    //    platform row's quiltt_api_key column is NULL, falls back to the
    //    global env var (preserves V2's sandbox during the transition).
    let quilttCfg;
    try {
      quilttCfg = await resolveQuilttConfigForPlatform(service, platform.data.id);
    } catch (cfgErr) {
      console.error('[or-quiltt-session-via-widget] config resolve failed:', cfgErr);
      return jsonResponse({ error: 'Quiltt config lookup failed' }, 500, cors);
    }
    const quilttApiKey = quilttCfg.apiKey;
    const connectorId = quilttCfg.connectorIdLink;
    if (!quilttApiKey) {
      console.error(
        `[or-quiltt-session-via-widget] no Quiltt API key for platform=${quilttCfg.platformSlug} (source=${quilttCfg.source.apiKey})`,
      );
      return jsonResponse({ error: 'Quiltt integration not configured (QUILTT_API_KEY)' }, 503, cors);
    }
    if (!connectorId) {
      console.error(
        `[or-quiltt-session-via-widget] no Quiltt connector_id for platform=${quilttCfg.platformSlug} (source=${quilttCfg.source.connectorIdLink})`,
      );
      return jsonResponse({ error: 'Quiltt integration not configured (connector id)' }, 503, cors);
    }

    // 6. Mint Quiltt session — reuse existing Profile when present, else mint
    //    fresh and stamp OR metadata for webhook round-tripping.
    const mintBody = mapLookup.data
      ? { userId: mapLookup.data.quiltt_profile_id }
      : {
          metadata: {
            or_tenant:        platform.data.slug,
            or_user_id:       session.data.app_user_id,
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
        { error: 'Quiltt rate limit hit (10 mints/hour, 20/day per profile). Cache client-side.' },
        429,
        cors,
      );
    }
    if (!mintResp.ok) {
      const errText = await mintResp.text().catch(() => '<unreadable>');
      console.error(`[or-quiltt-session-via-widget] Quiltt mint failed: ${mintResp.status} ${errText.slice(0, 300)}`);
      return jsonResponse({ error: 'Quiltt session mint failed' }, 502, cors);
    }
    const minted = await mintResp.json() as MintRespShape;
    if (!minted.token || !minted.userId || !minted.environmentId) {
      console.error('[or-quiltt-session-via-widget] Quiltt response shape unexpected');
      return jsonResponse({ error: 'Quiltt session response malformed' }, 502, cors);
    }

    // 7. Persist new profile mapping on first mint.
    if (!mapLookup.data) {
      const insertMap = await service
        .from('quiltt_profile_map')
        .insert({
          subaccount_id:         subaccountId,
          platform_id:           platform.data.id,
          quiltt_profile_id:     minted.userId,
          quiltt_environment_id: minted.environmentId,
        });
      if (insertMap.error) {
        console.error('[or-quiltt-session-via-widget] profile map insert failed:', insertMap.error.message);
        // Non-fatal — token is still usable; the worker resolves mapping on webhook arrival.
      }
    }

    return jsonResponse(
      {
        subaccount_id:  subaccountId,
        platform_slug:  platform.data.slug,
        app_user_id:    session.data.app_user_id,
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
    console.error('[or-quiltt-session-via-widget] error:', e instanceof Error ? e.message : String(e));
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
});
