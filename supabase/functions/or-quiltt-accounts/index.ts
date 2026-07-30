/**
 * or-quiltt-accounts — list the bank accounts under a Quiltt connection.
 *
 * Integrating apps call this immediately
 * after a successful Quiltt link to discover which accounts the user
 * just authorized. The response feeds the post-link review screen ("you
 * linked 3 accounts at Chase — pick which to import") and seeds the
 * integrator's local wallet rows.
 *
 * Why a dedicated endpoint: V2 cannot talk to Quiltt directly because
 * Quiltt's API key is bound to OR's account, and the per-user Profile
 * id lives in OR's `quiltt_profile_map`. OR brokers the GraphQL call
 * with Basic auth (`profile_id:api_key`) and hands back the cleartext
 * account metadata (institution name, mask, type, currency) — none of
 * which is sensitive enough to require ZKA-style encryption.
 *
 * Auth: X-Platform-API-Key (platform mode). Direct mode is rejected:
 * Quiltt accounts only make sense in the context of an integrator's
 * end-user, not an orangerails.com app session.
 *
 * POST body:
 *   app_user_id:           string  the integrating app's user id
 *   quiltt_connection_id:  string  Quiltt's connectionId returned by
 *                                  onExitSuccess in the popup flow
 *
 * Response 200 (quiltt_connection_id provided):
 *   { accounts: [...], connection_status: string|null,
 *     total_returned: number, excluded_closed: number,
 *     distinct_states: (string|null)[] }
 *
 * Response 200 (all-connections fallback):
 *   { accounts: [...], connections: [{id, status}],
 *     total_returned: number, excluded_closed: number,
 *     distinct_states: (string|null)[] }
 *
 * Response 400 — missing/bad fields
 * Response 401 — invalid platform key
 * Response 403 — direct mode rejected
 * Response 404 — no quiltt_profile_map for this (platform, app_user_id)
 * Response 502 — upstream Quiltt error
 * Response 503 — QUILTT_API_KEY not configured
 */

import { authenticateRequest } from '../_shared/platform-auth.ts';
import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { resolveQuilttConfigForPlatform } from '../_shared/quiltt-config.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';

const QUILTT_GRAPHQL = 'https://api.quiltt.io/v1/graphql';

interface AccountsBody {
  app_user_id?: string;
  quiltt_connection_id?: string;
}

interface QuilttAccount {
  id: string;
  name: string;
  mask: string | null;
  kind: string | null;
  state: string | null;
  currencyCode: string | null;
  institution: { name: string } | null;
  balance: { current: number | null; available: number | null } | null;
}

Deno.serve(wrapSentryHandler(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  try {
    const auth = await authenticateRequest(req);
    if ('status' in auth) {
      return jsonResponse({ error: auth.message }, auth.status, cors);
    }
    if (auth.mode !== 'platform') {
      return jsonResponse({ error: 'platform API key required' }, 403, cors);
    }

    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);
    const body = JSON.parse(raw || '{}') as AccountsBody;

    if (!body.app_user_id || typeof body.app_user_id !== 'string' || body.app_user_id.length > 256) {
      return jsonResponse({ error: 'app_user_id required (string, ≤256 chars)' }, 400, cors);
    }
    // quiltt_connection_id is OPTIONAL. When omitted (empty string), we
    // enumerate ALL connections under the profile. This is the fallback
    // path V2 uses when the popup's postMessage didn't survive a
    // cross-origin redirect (Finicity/MX PROD flows sever window.opener).
    const connectionId =
      typeof body.quiltt_connection_id === 'string' ? body.quiltt_connection_id.trim() : '';

    // Per-platform Quiltt API key resolution (env fallback during transition).
    let quilttCfg;
    try {
      quilttCfg = await resolveQuilttConfigForPlatform(auth.serviceClient, auth.platformId);
    } catch (cfgErr) {
      console.error('[or-quiltt-accounts] config resolve failed:', cfgErr);
      return jsonResponse({ error: 'Quiltt config lookup failed' }, 500, cors);
    }
    const apiKey = quilttCfg.apiKey;
    if (!apiKey) {
      console.error(
        `[or-quiltt-accounts] no Quiltt API key for platform=${quilttCfg.platformSlug} (source=${quilttCfg.source.apiKey})`,
      );
      return jsonResponse({ error: 'Quiltt not configured on OR' }, 503, cors);
    }

    // Resolve subaccount via (platform, external_user_id).
    const subLookup = await auth.serviceClient
      .from('subaccounts')
      .select('id')
      .eq('platform_id', auth.platformId)
      .eq('external_user_id', body.app_user_id)
      .maybeSingle();
    if (subLookup.error || !subLookup.data) {
      return jsonResponse(
        { error: 'subaccount not provisioned — call or-quiltt-session before linking' },
        404,
        cors,
      );
    }
    const subaccountId = subLookup.data.id as string;

    // Find the Quiltt profile id (needed for Basic auth).
    const mapLookup = await auth.serviceClient
      .from('quiltt_profile_map')
      .select('quiltt_profile_id')
      .eq('subaccount_id', subaccountId)
      .maybeSingle();
    if (mapLookup.error || !mapLookup.data) {
      return jsonResponse(
        { error: 'quiltt_profile_map missing for subaccount' },
        404,
        cors,
      );
    }
    const profileId = mapLookup.data.quiltt_profile_id as string;

    // Query Quiltt for the accounts. Two modes:
    //   - connectionId present: accounts under that one connection
    //   - connectionId empty: ALL accounts across ALL profile connections
    //     (fallback when the popup's postMessage was lost)
    // Schema reference: https://www.quiltt.dev/api-reference/graphql
    const basic = btoa(`${profileId}:${apiKey}`);
    let rawAccounts: QuilttAccount[] = [];
    let connectionStatusSingle: string | null = null;
    const connectionStatusAll: Array<{ id: string; status: string | null }> = [];

    if (connectionId) {
      const query = `
        query Q($connId: ID!) {
          connection(id: $connId) {
            id
            status
            accounts {
              id
              name
              mask
              kind
              state
              currencyCode
              institution { name }
              balance { current available }
            }
          }
        }
      `;
      const resp = await fetch(QUILTT_GRAPHQL, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { connId: connectionId } }),
      });
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        console.error(`[or-quiltt-accounts] Quiltt ${resp.status}: ${errBody.slice(0, 300)}`);
        return jsonResponse({ error: 'Upstream Quiltt error' }, 502, cors);
      }
      const json = await resp.json();
      if (json.errors) {
        console.error('[or-quiltt-accounts] Quiltt GraphQL errors:', JSON.stringify(json.errors).slice(0, 500));
        return jsonResponse({ error: 'Quiltt GraphQL error' }, 502, cors);
      }
      rawAccounts = json?.data?.connection?.accounts ?? [];
      connectionStatusSingle = json?.data?.connection?.status ?? null;
    } else {
      // Enumerate every connection under the profile and flatten accounts.
      const query = `
        query Q {
          connections {
            id
            status
            accounts {
              id
              name
              mask
              kind
              state
              currencyCode
              institution { name }
              balance { current available }
            }
          }
        }
      `;
      const resp = await fetch(QUILTT_GRAPHQL, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        console.error(`[or-quiltt-accounts] Quiltt(all) ${resp.status}: ${errBody.slice(0, 300)}`);
        return jsonResponse({ error: 'Upstream Quiltt error' }, 502, cors);
      }
      const json = await resp.json();
      if (json.errors) {
        console.error('[or-quiltt-accounts] Quiltt(all) GraphQL errors:', JSON.stringify(json.errors).slice(0, 500));
        return jsonResponse({ error: 'Quiltt GraphQL error' }, 502, cors);
      }
      const conns = (json?.data?.connections ?? []) as Array<{ id: string; status?: string | null; accounts?: QuilttAccount[] }>;
      rawAccounts = conns.flatMap((c) => c.accounts ?? []);
      conns.forEach((c) => connectionStatusAll.push({ id: c.id, status: c.status ?? null }));
    }

    // Warn-and-include (not warn-and-exclude) for accounts with null/undefined state.
    // Excluding on uncertainty is the original bug class: include and make it visible.
    const nullStateAccounts = rawAccounts.filter((a) => !a.state);
    if (nullStateAccounts.length > 0) {
      console.warn(
        `[or-quiltt-accounts] ${nullStateAccounts.length} account(s) returned null/undefined state ` +
        `(ids: ${nullStateAccounts.map((a) => a.id).join(', ')}) -- including in results`,
      );
    }

    // Counters: every caller can see what Quiltt returned and what was filtered.
    const totalReturned = rawAccounts.length;
    const excludedClosed = rawAccounts.filter((a) => a.state === 'CLOSED').length;
    const distinctStates = [...new Set(rawAccounts.map((a) => a.state))];

    // Denylist: exclude only CLOSED. We never allowlist an enum we do not own;
    // a vendor adding a new account state must never silently drop rows.
    const accounts = rawAccounts
      .filter((a) => a.state !== 'CLOSED')
      .map((a) => ({
        id:               a.id,
        name:             a.name,
        institution_name: a.institution?.name ?? null,
        kind:             a.kind ?? null,
        mask:             a.mask ?? null,
        currency:         a.currencyCode ?? null,
        state:            a.state,
        balance_current:  a.balance?.current ?? null,
        balance_available: a.balance?.available ?? null,
      }));

    const responseBody = connectionId
      ? {
          accounts,
          connection_status: connectionStatusSingle,
          total_returned: totalReturned,
          excluded_closed: excludedClosed,
          distinct_states: distinctStates,
        }
      : {
          accounts,
          connections: connectionStatusAll,
          total_returned: totalReturned,
          excluded_closed: excludedClosed,
          distinct_states: distinctStates,
        };
    return jsonResponse(responseBody, 200, cors);
  } catch (e) {
    console.error('[or-quiltt-accounts] fatal:', e instanceof Error ? e.message : String(e));
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
}, 'or-quiltt-accounts'));
