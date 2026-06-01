/**
 * or-institutions-catalog — search Quiltt's institution catalog.
 *
 * Consumer apps (V2, OW) call this from their picker on each keystroke
 * to render real bank tiles (Chase, BofA, FinBank, ...) alongside the
 * OR provider tiles.
 *
 * Why search-based (not full-list): Quiltt's connector institutions
 * endpoint is `GET /v1/sdk/connectors/{id}/institutions?term=<q>` — it
 * doesn't expose a paginated full-catalog query. Searching with the
 * user's typed term is the supported pattern.
 *
 * Auth: NONE. Institution names + logos are not PII. CORS open to
 * OR's allowlist.
 *
 * Session JWT handling: each search needs a Quiltt session JWT bound
 * to a Profile. Quiltt rate-limits session mints (10/hr per Profile),
 * so we mint ONCE (using QUILTT_CATALOG_PROFILE_ID env, or auto-mint
 * a service Profile) and cache the JWT in an in-memory module global
 * across edge-function invocations within the same isolate. On 401 we
 * re-mint and retry once.
 *
 * GET /or-institutions-catalog?q=fin[&connector_id=...]
 *   - q: 2+ chars (1-char queries are too noisy + Quiltt returns nothing)
 *   - connector_id: defaults to QUILTT_CONNECTOR_ID_LINK env
 *
 * Response 200:
 *   {
 *     connector_id: "sckzokhrdg",
 *     q: "fin",
 *     institutions: [
 *       { id, name, logo_url, kind, providers?, primary_provider? }
 *     ]
 *   }
 */

import { buildPublicCorsHeaders, jsonResponse } from '../_shared/http.ts';

const QUILTT_AUTH_URL = 'https://auth.quiltt.io/v1/users/sessions';
const QUILTT_REST_BASE = 'https://api.quiltt.io/v1';

// Module-global session cache. Edge function isolates may re-spawn so
// this isn't perfectly persistent, but it dramatically cuts the mint
// rate for hot-path searches.
let cachedSessionToken: string | null = null;
let cachedSessionExpiresAt: number | null = null;

async function getCatalogSessionToken(apiKey: string): Promise<string> {
  const now = Date.now();
  if (
    cachedSessionToken &&
    cachedSessionExpiresAt &&
    cachedSessionExpiresAt - now > 60_000 /* 1 min safety margin */
  ) {
    return cachedSessionToken;
  }
  const catalogProfileId = Deno.env.get('QUILTT_CATALOG_PROFILE_ID') ?? '';
  const mintBody = catalogProfileId
    ? { userId: catalogProfileId }
    : { metadata: { or_purpose: 'institution_catalog' } };
  const resp = await fetch(QUILTT_AUTH_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(mintBody),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Quiltt session mint ${resp.status}: ${text.slice(0, 200)}`);
  }
  const json = await resp.json();
  const token = (json?.token ?? json?.session_token) as string | undefined;
  if (!token) throw new Error('Quiltt session response missing token');
  // Default to 1h cache; Quiltt JWTs typically last 24h but we re-mint
  // on 401 anyway so under-caching is safer than over.
  cachedSessionToken = token;
  cachedSessionExpiresAt = now + 60 * 60 * 1000;
  return token;
}

interface QuilttInstitutionApi {
  id: string;
  name: string;
  logo?: { url?: string } | null;
  kind?: string | null;
  primary_provider?: string | null;
  providers?: string[] | null;
}

async function searchQuilttInstitutions(
  sessionToken: string,
  connectorId: string,
  term: string,
): Promise<QuilttInstitutionApi[]> {
  const params = new URLSearchParams({ term });
  const url = `${QUILTT_REST_BASE}/sdk/connectors/${connectorId}/institutions?${params}`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${sessionToken}`,
      'Content-Type':  'application/json',
    },
  });
  if (resp.status === 401) {
    const err = new Error('Quiltt 401');
    (err as Error & { code?: string }).code = 'QUILTT_AUTH';
    throw err;
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Quiltt institution search ${resp.status}: ${text.slice(0, 200)}`);
  }
  const json = await resp.json();
  // Response shape per Quiltt SDK: { data: [...] } or [...] directly.
  const list = Array.isArray(json) ? json : (json?.data ?? json?.institutions ?? []);
  return list as QuilttInstitutionApi[];
}

Deno.serve(async (req: Request) => {
  const cors = buildPublicCorsHeaders();
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim();
  const connectorId = url.searchParams.get('connector_id')
    ?? Deno.env.get('QUILTT_CONNECTOR_ID_LINK')
    ?? '';

  if (!connectorId) {
    return jsonResponse(
      { error: 'connector_id query param or QUILTT_CONNECTOR_ID_LINK env required' },
      400,
      cors,
    );
  }
  if (q.length < 2) {
    return jsonResponse(
      {
        connector_id: connectorId,
        q,
        institutions: [],
        hint: 'Pass ?q=<term> with at least 2 characters to search.',
      },
      200,
      { ...cors, 'cache-control': 'public, max-age=60' },
    );
  }

  const apiKey = Deno.env.get('QUILTT_API_KEY');
  if (!apiKey) {
    return jsonResponse({ error: 'Quiltt not configured on OR' }, 503, cors);
  }

  try {
    let sessionToken = await getCatalogSessionToken(apiKey);
    let list: QuilttInstitutionApi[];
    try {
      list = await searchQuilttInstitutions(sessionToken, connectorId, q);
    } catch (e) {
      if ((e as Error & { code?: string }).code === 'QUILTT_AUTH') {
        // 401 → invalidate cache, re-mint, retry once.
        cachedSessionToken = null;
        cachedSessionExpiresAt = null;
        sessionToken = await getCatalogSessionToken(apiKey);
        list = await searchQuilttInstitutions(sessionToken, connectorId, q);
      } else {
        throw e;
      }
    }
    const institutions = list.slice(0, 30).map((inst) => ({
      id:       inst.id,
      name:     inst.name,
      logo_url: inst.logo?.url ?? null,
      kind:     inst.kind ?? null,
      primary_provider: inst.primary_provider ?? null,
    }));
    return jsonResponse(
      {
        connector_id: connectorId,
        q,
        institutions,
      },
      200,
      {
        ...cors,
        // Browser-side cache: 10 min per term. Quiltt's catalog is
        // stable; if a bank gets added the picker just shows it next
        // time the term expires.
        'cache-control': 'public, max-age=600',
      },
    );
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error('[or-institutions-catalog] search failed:', errMsg);
    return jsonResponse(
      {
        connector_id: connectorId,
        q,
        institutions: [],
        // Diagnostic — surfaces upstream Quiltt errors so consumers can
        // tell apart "Quiltt down" vs "no banks matched". Includes the
        // upstream HTTP code when available; never includes secrets.
        warning: `Catalog search failed: ${errMsg.slice(0, 250)}`,
      },
      200,
      { ...cors, 'cache-control': 'no-store' },
    );
  }
});
