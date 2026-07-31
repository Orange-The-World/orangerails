/**
 * or-quiltt-accounts: list the bank accounts under a Quiltt connection.
 *
 * Integrating apps call this immediately
 * after a successful Quiltt link to discover which accounts the user
 * just authorized. The response feeds the post-link review screen ("you
 * linked 3 accounts at Chase, pick which to import") and seeds the
 * integrator's local wallet rows.
 *
 * Why a dedicated endpoint: V2 cannot talk to Quiltt directly because
 * Quiltt's API key is bound to OR's account, and the per-user Profile
 * id lives in OR's `quiltt_profile_map`. OR brokers the GraphQL call
 * with Basic auth (`profile_id:api_key`) and hands back the cleartext
 * account metadata (institution name, mask, type, currency), none of
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
 * Response 200 (same shape in both modes):
 *   { accounts: [
 *       { id, name, institution_name, kind, mask, currency, state,
 *         balance_current, balance_available,
 *         connection: { id, status } | null },
 *       ...
 *     ],
 *     total_returned:  number            how many accounts Quiltt returned
 *     excluded_closed: number            how many this function dropped
 *     distinct_states: (string|null)[]   every state Quiltt used in this response
 *     source_disagreement: number        profile-wide only; see below
 *   }
 *
 * The counters exist so a caller who sees "fewer accounts than I
 * expected" can tell the difference between Quiltt returning few and OR
 * dropping many, without needing our logs. DL-0326 burned ten days on
 * exactly that ambiguity, so they are part of the contract, not debug
 * output.
 *
 * Profile-wide mode (no quiltt_connection_id) asks Quiltt for the account set
 * two ways in one document, the root `accounts` field and the accounts under
 * each `connections` entry, and returns the union. Neither root's no-filter
 * default is documented, so neither can be shown from outside to be the
 * complete one, and a union cannot return fewer accounts than either alone.
 * `source_disagreement` counts the accounts only one source listed; it is 0
 * for the single-connection mode, which has one source.
 *
 * The 200 body is built by `buildAccountsResponse` in ./transform.ts, which
 * is a separate module so the response contract can be asserted against
 * fixtures without booting this server or holding a Quiltt credential. The
 * assertions live in ./transform.test.ts. If you change the shape, change
 * them together.
 *
 * Response 400: missing/bad fields
 * Response 401: invalid platform key
 * Response 403: direct mode rejected
 * Response 404: no quiltt_profile_map for this (platform, app_user_id)
 * Response 502: upstream Quiltt error
 * Response 503: QUILTT_API_KEY not configured
 */

import { authenticateRequest } from '../_shared/platform-auth.ts';
import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { resolveQuilttConfigForPlatform } from '../_shared/quiltt-config.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';
import { buildAccountsResponse, mergeAccountSets } from './transform.ts';
import type { QuilttAccount } from './transform.ts';

const QUILTT_GRAPHQL = 'https://api.quiltt.io/v1/graphql';

interface AccountsBody {
  app_user_id?: string;
  quiltt_connection_id?: string;
}

/**
 * The selection set every account query in this file uses. It exists once so
 * the two profile-wide sources cannot drift apart: a field present on one and
 * missing on the other would make the union look like a disagreement.
 */
const ACCOUNT_FIELDS = `
  id
  name
  mask
  kind
  state
  currencyCode
  institution { name }
  balance { current available }
  connection { id status }
`;

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
      return jsonResponse({ error: 'app_user_id required (string, <=256 chars)' }, 400, cors);
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
        { error: 'subaccount not provisioned: call or-quiltt-session before linking' },
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

    // One place that posts a GraphQL document, so the two profile-wide
    // attempts below cannot drift in their error handling.
    const postQuiltt = async (
      label: string,
      query: string,
      variables?: Record<string, unknown>,
    ): Promise<{ data?: Record<string, unknown>; graphqlErrors?: unknown; httpFailed?: true }> => {
      const resp = await fetch(QUILTT_GRAPHQL, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(variables ? { query, variables } : { query }),
      });
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        console.error(`[or-quiltt-accounts] ${label} ${resp.status}: ${errBody.slice(0, 300)}`);
        return { httpFailed: true };
      }
      const json = await resp.json();
      if (json.errors) {
        console.error(`[or-quiltt-accounts] ${label} GraphQL errors:`, JSON.stringify(json.errors).slice(0, 500));
        return { graphqlErrors: json.errors };
      }
      return { data: json?.data ?? {} };
    };

    if (connectionId) {
      const result = await postQuiltt(
        'Quiltt',
        `query Q($connId: ID!) { connection(id: $connId) { id accounts { ${ACCOUNT_FIELDS} } } }`,
        { connId: connectionId },
      );
      if (result.httpFailed) return jsonResponse({ error: 'Upstream Quiltt error' }, 502, cors);
      if (result.graphqlErrors) return jsonResponse({ error: 'Quiltt GraphQL error' }, 502, cors);

      const conn = result.data?.connection as { accounts?: QuilttAccount[] } | null | undefined;
      return jsonResponse(buildAccountsResponse(conn?.accounts ?? []), 200, cors);
    }

    // Profile-wide: every account under the profile, from both roots that
    // claim to list them, unioned. See mergeAccountSets in ./transform.ts for
    // why this asks twice. Per Quiltt's schema reference both roots return a
    // plain list rather than a cursor page, so there is no page to miss.
    const union = await postQuiltt(
      'Quiltt(all)',
      `query Q {
         accounts { ${ACCOUNT_FIELDS} }
         connections { id status accounts { ${ACCOUNT_FIELDS} } }
       }`,
    );
    if (union.httpFailed) return jsonResponse({ error: 'Upstream Quiltt error' }, 502, cors);

    if (!union.graphqlErrors) {
      const fromRoot = (union.data?.accounts ?? []) as QuilttAccount[];
      const conns = (union.data?.connections ?? []) as Array<{ accounts?: QuilttAccount[] }>;
      const fromConnections = conns.flatMap((c) => c.accounts ?? []);
      const merged = mergeAccountSets(fromRoot, fromConnections);
      const disagreement = merged.only_in_root.length + merged.only_in_connections.length;
      return jsonResponse(buildAccountsResponse(merged.accounts, disagreement), 200, cors);
    }

    // The union document was rejected. The root `accounts` field is documented
    // but has never been exercised against this schema from here, and a single
    // unknown field makes GraphQL reject the whole document rather than the one
    // selection. Retry with the connections-only query this branch shipped with,
    // so an unavailable root field degrades to the previous behaviour instead of
    // taking the fallback path down. The error above is already logged.
    console.warn('[or-quiltt-accounts] union query rejected, retrying connections-only');
    const connsOnly = await postQuiltt(
      'Quiltt(all,connections-only)',
      `query Q { connections { id accounts { ${ACCOUNT_FIELDS} } } }`,
    );
    if (connsOnly.httpFailed) return jsonResponse({ error: 'Upstream Quiltt error' }, 502, cors);
    if (connsOnly.graphqlErrors) return jsonResponse({ error: 'Quiltt GraphQL error' }, 502, cors);

    const conns = (connsOnly.data?.connections ?? []) as Array<{ accounts?: QuilttAccount[] }>;
    return jsonResponse(buildAccountsResponse(conns.flatMap((c) => c.accounts ?? [])), 200, cors);
  } catch (e) {
    console.error('[or-quiltt-accounts] fatal:', e instanceof Error ? e.message : String(e));
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
}, 'or-quiltt-accounts'));
