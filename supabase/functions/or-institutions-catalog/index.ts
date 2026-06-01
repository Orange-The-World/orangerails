/**
 * or-institutions-catalog — return the full Quiltt institution catalog
 * so consumer apps (V2, OW) can render bank tiles in their picker
 * WITHOUT minting a per-user Quiltt session.
 *
 * Strategy:
 *  - Cache the institution list in `quiltt_institutions_cache` (24h TTL).
 *  - On cache miss/stale: mint a session for OR's "catalog" Quiltt
 *    Profile (env var or auto-created), paginate Quiltt's
 *    `institutions()` GraphQL query, upsert into the cache table.
 *  - Always return the cached rows (even if a background refresh just
 *    started) so the client never blocks on a slow Quiltt response.
 *
 * Auth: NONE — institution names + logos are not PII. Same threat
 * model as the providers catalog endpoint. The endpoint is rate-limited
 * by the Supabase platform default. CORS is open to OR's allowlist.
 *
 * GET response 200:
 *   {
 *     connector_id: "sckzokhrdg",
 *     refreshed_at: "2026-06-01T10:00:00Z",
 *     institutions: [
 *       { id: "inst_...", name: "Chase", logo_url: "...", raw: {...} },
 *       ...
 *     ]
 *   }
 *
 * Response 503 if Quiltt isn't configured (QUILTT_API_KEY missing).
 */

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildPublicCorsHeaders, jsonResponse } from '../_shared/http.ts';

const QUILTT_AUTH_URL = 'https://auth.quiltt.io/v1/users/sessions';
const QUILTT_GRAPHQL  = 'https://api.quiltt.io/v1/graphql';
const CACHE_TTL_MS    = 24 * 60 * 60 * 1000; // 24h
const PAGE_SIZE       = 100;
const MAX_PAGES       = 50; // 5,000 institution ceiling per refresh

interface InstitutionRow {
  id: string;
  name: string;
  logo_url: string | null;
  raw: unknown;
}

function makeServiceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );
}

async function mintCatalogSession(apiKey: string): Promise<string> {
  // The catalog session is shared across all integrators — it links to a
  // dedicated "OR catalog" Profile that's never used for real bank links.
  // Reuse via QUILTT_CATALOG_PROFILE_ID when set; otherwise mint fresh.
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
    const errText = await resp.text().catch(() => '');
    throw new Error(`Quiltt session mint failed ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const json = await resp.json();
  const token = json?.token ?? json?.session_token;
  if (!token) throw new Error('Quiltt session response missing token');
  return token as string;
}

async function paginateInstitutions(
  sessionToken: string,
  connectorId: string,
): Promise<InstitutionRow[]> {
  // Quiltt's institutions(filter, search, sort) returns [Account!].
  // For the catalog endpoint we want every institution Quiltt indexes
  // for this connector — no filter, paginate via offset.
  const rows: InstitutionRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = `
      query Catalog($connectorId: ID!, $offset: Int!, $first: Int!) {
        institutions(connectorId: $connectorId, offset: $offset, first: $first) {
          id
          name
          logo { url }
        }
      }
    `;
    const resp = await fetch(QUILTT_GRAPHQL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        query,
        variables: { connectorId, offset: page * PAGE_SIZE, first: PAGE_SIZE },
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Quiltt institutions ${resp.status}: ${text.slice(0, 200)}`);
    }
    const json = await resp.json();
    if (json.errors) {
      // Fallback: try the simpler `institutions` root query without
      // connector arg — older Quiltt schemas may not accept connectorId.
      const fallbackQuery = `
        query Catalog {
          institutions {
            id
            name
            logo { url }
          }
        }
      `;
      const fbResp = await fetch(QUILTT_GRAPHQL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sessionToken}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ query: fallbackQuery }),
      });
      if (!fbResp.ok) {
        throw new Error(`Quiltt institutions fallback ${fbResp.status}`);
      }
      const fbJson = await fbResp.json();
      const fbList = fbJson?.data?.institutions ?? [];
      for (const inst of fbList) {
        rows.push({
          id: inst.id,
          name: inst.name,
          logo_url: inst.logo?.url ?? null,
          raw: inst,
        });
      }
      return rows;
    }
    const list = json?.data?.institutions ?? [];
    for (const inst of list) {
      rows.push({
        id: inst.id,
        name: inst.name,
        logo_url: inst.logo?.url ?? null,
        raw: inst,
      });
    }
    if (list.length < PAGE_SIZE) break;
  }
  return rows;
}

async function refreshCache(
  service: SupabaseClient,
  connectorId: string,
  apiKey: string,
): Promise<void> {
  const sessionToken = await mintCatalogSession(apiKey);
  const rows = await paginateInstitutions(sessionToken, connectorId);
  if (rows.length === 0) return;

  const now = new Date().toISOString();
  const insertRows = rows.map((r) => ({
    connector_id:  connectorId,
    institution_id: r.id,
    name:          r.name,
    logo_url:      r.logo_url,
    searchable:    r.name.toLowerCase(),
    raw:           r.raw,
    refreshed_at:  now,
  }));

  // Upsert in chunks (Supabase limits batch size).
  for (let i = 0; i < insertRows.length; i += 500) {
    const chunk = insertRows.slice(i, i + 500);
    const up = await service
      .from('quiltt_institutions_cache')
      .upsert(chunk, { onConflict: 'connector_id,institution_id' });
    if (up.error) {
      console.error('[or-institutions-catalog] upsert failed:', up.error.message);
      throw up.error;
    }
  }
}

Deno.serve(async (req: Request) => {
  const cors = buildPublicCorsHeaders();
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  const url = new URL(req.url);
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
  const apiKey = Deno.env.get('QUILTT_API_KEY');
  if (!apiKey) {
    return jsonResponse({ error: 'Quiltt not configured on OR' }, 503, cors);
  }

  const service = makeServiceClient();

  // 1. Read current cache snapshot.
  const cached = await service
    .from('quiltt_institutions_cache')
    .select('institution_id, name, logo_url, raw, refreshed_at')
    .eq('connector_id', connectorId)
    .order('name', { ascending: true });
  if (cached.error) {
    console.error('[or-institutions-catalog] cache read failed:', cached.error.message);
    return jsonResponse({ error: 'Cache read failed' }, 500, cors);
  }

  const cacheRows = cached.data ?? [];
  const cacheStale = cacheRows.length === 0 ||
    (new Date().getTime() - new Date(cacheRows[0].refreshed_at as string).getTime()) > CACHE_TTL_MS;

  // 2. If empty: refresh inline so the first caller doesn't see an empty
  //    list. If stale-but-populated: refresh in background and return
  //    what we have (fast path for warm cache).
  if (cacheRows.length === 0) {
    try {
      await refreshCache(service, connectorId, apiKey);
    } catch (e) {
      console.error('[or-institutions-catalog] refresh failed:', e instanceof Error ? e.message : String(e));
      // Return empty rather than 500 so the client picker still functions.
      return jsonResponse(
        {
          connector_id: connectorId,
          refreshed_at: null,
          institutions: [],
          warning: 'Catalog refresh failed; consumer should fall back to OR picker.',
        },
        200,
        { ...cors, 'cache-control': 'no-store' },
      );
    }
    const fresh = await service
      .from('quiltt_institutions_cache')
      .select('institution_id, name, logo_url, raw, refreshed_at')
      .eq('connector_id', connectorId)
      .order('name', { ascending: true });
    return jsonResponse(
      {
        connector_id: connectorId,
        refreshed_at: fresh.data?.[0]?.refreshed_at ?? null,
        institutions: (fresh.data ?? []).map((r) => ({
          id:        r.institution_id,
          name:      r.name,
          logo_url:  r.logo_url,
        })),
      },
      200,
      { ...cors, 'cache-control': 'public, max-age=3600' },
    );
  }

  if (cacheStale) {
    // Background refresh — don't await. Fire and forget; next caller
    // sees the new data. Use Deno's `waitUntil`-style queueMicrotask
    // since edge functions cut off on response.
    refreshCache(service, connectorId, apiKey).catch((e) => {
      console.error('[or-institutions-catalog] background refresh failed:', e instanceof Error ? e.message : String(e));
    });
  }

  return jsonResponse(
    {
      connector_id: connectorId,
      refreshed_at: cacheRows[0].refreshed_at,
      institutions: cacheRows.map((r) => ({
        id:       r.institution_id,
        name:     r.name,
        logo_url: r.logo_url,
      })),
    },
    200,
    {
      ...cors,
      // Browsers can cache the response for 1 hour. The cache stale-refresh
      // happens server-side based on refreshed_at, not on this header.
      'cache-control': 'public, max-age=3600',
    },
  );
});
