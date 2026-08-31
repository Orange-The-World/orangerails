/**
 * or-institutions-catalog , search Quiltt's institution catalog.
 *
 * Consumer apps (V2, OW) call this from their picker on each keystroke
 * to render real bank tiles (Chase, BofA, FinBank, ...) alongside the
 * OR provider tiles.
 *
 * Why search-based (not full-list): Quiltt's connector institutions
 * endpoint is `GET /v1/sdk/connectors/{id}/institutions?term=<q>` , it
 * doesn't expose a paginated full-catalog query. Searching with the
 * user's typed term is the supported pattern.
 *
 * Auth: NONE, deliberately. Institution names and logos are not PII, and
 * this function builds no Supabase client, so it holds no service_role key
 * and has no database reach. Declared as "none" in public-auth.json.
 *
 * CORS: wide open, and NOT an allowlist. buildPublicCorsHeaders returns
 * Access-Control-Allow-Origin: * for every request. The allowlist in
 * _shared/http.ts belongs to buildCorsHeaders, which this function does not
 * call. An earlier version of this comment said the allowlist applied here;
 * it did not. CORS is not a control on this path in any case, because a
 * non-browser caller ignores it entirely.
 *
 * Anonymous-caller throttle: see RATE LIMIT below. The session cache in this
 * file bounds Quiltt session MINTS only, never searches, so on its own it was
 * never a limit on what an anonymous caller can spend of our Quiltt quota.
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
 *
 * Other responses a caller must handle:
 *   400 { error: "invalid connector_id" }  the connector_id in the query
 *        string is not 1 to 64 characters of A-Z, a-z, 0-9, hyphen or
 *        underscore. Not retryable: fix the value.
 *   429 { error: "rate_limited" } with a retry-after header, in seconds.
 *        Retryable after that many seconds.
 *   502 { error: "upstream_failure", correlation_id: "..." }  Quiltt
 *        failed. Retryable. The upstream provider's own error text is
 *        logged server-side and deliberately NOT returned, because this
 *        endpoint answers anonymous callers. Quote correlation_id when
 *        reporting the failure and it can be matched to the log line.
 *   503 { error: "Quiltt not configured on OR" }  our configuration, not
 *        the caller's request. Retrying will not help until we fix it.
 */

import { buildPublicCorsHeaders, jsonResponse } from '../_shared/http.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';
import { clientIdOrNull, rateLimitRetryAfter } from './rate-limit.ts';

const QUILTT_AUTH_URL = 'https://auth.quiltt.io/v1/users/sessions';
const QUILTT_REST_BASE = 'https://api.quiltt.io/v1';

// ── connector_id validation ──────────────────────────────────────────
// connector_id arrives from the query string and is interpolated into an
// upstream URL PATH, and our Quiltt session bearer travels with that request.
// URL parsing normalises dot-dot segments before the fetch leaves this
// isolate, so an unvalidated value can reshape WHICH path on api.quiltt.io we
// call while still carrying our credential. The host is pinned by
// QUILTT_REST_BASE so this never reaches a caller-controlled server, but
// reshaping our own upstream path is not something an anonymous caller gets
// to do.
//
// Quiltt issues short opaque handles (the documented example is
// "sckzokhrdg"). The pattern below is deliberately a narrow allowlist rather
// than a blocklist of bad characters: nothing outside this class can express
// a path separator, a dot segment, a query, a fragment or a percent escape,
// so there is no encoding trick left to find.
const CONNECTOR_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

interface CatalogInstitution {
  id: string;
  name: string;
  logo_url: string | null;
  kind: string | null;
  primary_provider: string | null;
}

// ── RATE LIMIT ───────────────────────────────────────────────────────
// What this endpoint risks is our Quiltt credential and quota: every request
// with q of 2 or more characters becomes a search against Quiltt under our
// API key, and an anonymous caller can loop it.
//
// Two stateless bounds. It is worth being exact about what each one does and
// does not stop, because a limiter that cannot limit is worse than none: it
// stops people looking.
//
//   1. A per-isolate, per-client-IP counter over a 60 second window, keyed on
//      an edge-set header wherever one exists. Lives in ./rate-limit.ts now
//      (OR-T1140, OR-T1141), split out so it carries no Deno.serve call and
//      can be unit tested directly; see clientIdOrNull and pruneRateWindows
//      there for the header precedence and the eviction-order reasoning. It
//      slows the naive loop from one machine. It does NOT stop a caller
//      spread over many addresses, it does not stop a caller who can forge
//      every identifying header, and because every edge isolate keeps its
//      own counter, a caller whose requests land on different isolates gets
//      one allowance per isolate. It is a floor, not a ceiling.
//   2. A per-isolate memo of the mapped response, keyed by connector_id and
//      the exact term. This is the one that protects the credential: a
//      repeated term costs zero upstream calls for its TTL, whoever is
//      asking. It does nothing against randomised terms, which is exactly why
//      1 exists as well. The term is NOT lowercased for the key: we do not
//      know that Quiltt's search is case insensitive, and guessing wrong
//      would serve one term's results under another.
//
// A limit that genuinely holds across all callers needs shared state. The one
// shared limiter this repo has, _shared/rate-limit.ts, is backed by
// public.platform_rate_limits and needs a Supabase client. This function
// deliberately builds none, and that absence is precisely why it has no
// service_role reach and no database exposure. Buying a rate limit by handing
// a service_role key to an unauthenticated public endpoint is a worse trade
// than the one it fixes, so it is not done here. The durable fix is a
// gateway-level rule in front of the function: separate change, separate
// owner.

const CATALOG_CACHE_TTL_MS = 10 * 60 * 1000; // matches the max-age we already send
const CATALOG_CACHE_MAX_ENTRIES = 500;
const catalogCache = new Map<string, { storedAt: number; institutions: CatalogInstitution[] }>();

/** NUL cannot appear in either part, so the joined key is unambiguous. */
function cacheKey(connectorId: string, term: string): string {
  return `${connectorId}\u0000${term}`;
}

function readCatalogCache(key: string, now: number): CatalogInstitution[] | null {
  const hit = catalogCache.get(key);
  if (!hit) return null;
  if (now - hit.storedAt >= CATALOG_CACHE_TTL_MS) {
    catalogCache.delete(key);
    return null;
  }
  return hit.institutions;
}

function writeCatalogCache(key: string, institutions: CatalogInstitution[], now: number): void {
  if (catalogCache.size >= CATALOG_CACHE_MAX_ENTRIES) {
    for (const [k, entry] of catalogCache) {
      if (now - entry.storedAt >= CATALOG_CACHE_TTL_MS) catalogCache.delete(k);
    }
    if (catalogCache.size >= CATALOG_CACHE_MAX_ENTRIES) catalogCache.clear();
  }
  catalogCache.set(key, { storedAt: now, institutions });
}

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
  // connectorId is checked against CONNECTOR_ID_RE before it reaches here, so
  // this encode is a no-op today. It stays as defence in depth: it is the line
  // that would still hold if the pattern were ever loosened. Do not remove one
  // of the two without re-reading the other.
  const url = `${QUILTT_REST_BASE}/sdk/connectors/${encodeURIComponent(connectorId)}/institutions?${params}`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization':   `Bearer ${sessionToken}`,
      'Content-Type':    'application/json',
      'Accept':          'application/json',
      // Quiltt's /sdk/* endpoints reject calls without this header
      // (returns 403 "This endpoint must be called from..."). Format
      // per @quiltt/core utils/getSDKAgent , "Quiltt/<ver> (<platform>)".
      'Quiltt-SDK-Agent': 'Quiltt/6.0.0 (Server)',
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

Deno.serve(wrapSentryHandler(async (req: Request) => {
  const cors = buildPublicCorsHeaders();
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim();
  const connectorIdParam = url.searchParams.get('connector_id');
  const connectorId = connectorIdParam
    ?? Deno.env.get('QUILTT_CONNECTOR_ID_LINK')
    ?? '';

  if (!connectorId) {
    return jsonResponse(
      { error: 'connector_id query param or QUILTT_CONNECTOR_ID_LINK env required' },
      400,
      cors,
    );
  }
  if (!CONNECTOR_ID_RE.test(connectorId)) {
    // Two different faults share this branch and must not share a status. A
    // bad value in the query string is the caller's mistake: 400. A bad value
    // in QUILTT_CONNECTOR_ID_LINK is ours, and telling an anonymous caller
    // "your input is invalid" when they sent no input sends whoever debugs it
    // in exactly the wrong direction.
    if (connectorIdParam !== null) {
      return jsonResponse(
        {
          error: 'invalid connector_id',
          detail: 'connector_id must be 1 to 64 characters of A-Z, a-z, 0-9, hyphen or underscore.',
        },
        400,
        cors,
      );
    }
    console.error(
      '[or-institutions-catalog] QUILTT_CONNECTOR_ID_LINK is set to a value that is not a valid connector id',
    );
    return jsonResponse({ error: 'Quiltt not configured on OR' }, 503, cors);
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

  // Only requests that can actually cost us a Quiltt search are counted, and
  // the ORDER of the next two blocks is what makes that sentence true. A
  // 1-character query returned above never leaves this isolate. A term already
  // in the memo costs zero upstream calls too, so the memo is read FIRST: a
  // memo hit is never charged against the caller's allowance and can never be
  // answered 429. The picker fires on each keystroke, so the caller most
  // likely to trip a limiter is an ordinary user typing through terms we can
  // serve for free.
  const now = Date.now();
  const memoKey = cacheKey(connectorId, q);
  const memoized = readCatalogCache(memoKey, now);
  if (memoized) {
    return jsonResponse(
      { connector_id: connectorId, q, institutions: memoized },
      200,
      { ...cors, 'cache-control': 'public, max-age=600' },
    );
  }

  const clientId = clientIdOrNull(req);
  if (clientId) {
    const retryAfter = rateLimitRetryAfter(clientId, now);
    if (retryAfter > 0) {
      return jsonResponse(
        {
          error: 'rate_limited',
          detail: `Too many catalog searches. Try again in ${retryAfter}s.`,
        },
        429,
        { ...cors, 'retry-after': String(retryAfter), 'cache-control': 'no-store' },
      );
    }
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
    const institutions: CatalogInstitution[] = list.slice(0, 30).map((inst) => ({
      id:       inst.id,
      name:     inst.name,
      logo_url: inst.logo?.url ?? null,
      kind:     inst.kind ?? null,
      primary_provider: inst.primary_provider ?? null,
    }));
    // Only successful searches are memoized. Caching a failure would turn one
    // bad minute upstream into ten minutes of serving an empty catalog to
    // everyone who lands on this isolate.
    writeCatalogCache(memoKey, institutions, Date.now());
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
    // The upstream text is LOGGED, never returned. errMsg can carry up to 200
    // characters of Quiltt's own response body from a failed session mint. Our
    // API key is never in it, but whatever Quiltt chooses to say about our
    // account or auth state can be, and this endpoint answers anonymous
    // callers with no identity at all. The correlation id is what lets support
    // tie a user's report to this log line without putting the provider's
    // words on the wire.
    const correlationId = crypto.randomUUID();
    console.error(
      `[or-institutions-catalog] search failed (correlation_id=${correlationId}):`,
      errMsg,
    );
    return jsonResponse(
      {
        connector_id: connectorId,
        q,
        institutions: [],
        // Returns 502, not 200, so callers detect failure via HTTP status
        // rather than body scanning. The status is the whole signal a caller
        // needs: it separates "Quiltt down" from "no banks matched", which is
        // the job the removed upstream text was doing.
        error: 'upstream_failure',
        correlation_id: correlationId,
        warning: 'Catalog search failed upstream. Quote correlation_id when reporting this.',
      },
      502,
      { ...cors, 'cache-control': 'no-store' },
    );
  }
}, 'or-institutions-catalog'));
