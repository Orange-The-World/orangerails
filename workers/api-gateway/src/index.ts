/**
 * api.orangerails.com , canonical API gateway.
 *
 * Replaces the per-client hardcoded Supabase URL pattern with a single
 * canonical entry point. Clients only ever know about
 * `https://api.orangerails.com` plus a versioned path. If OR migrates
 * Supabase project, region, or hosting platform the only place that
 * changes is this Worker's config.
 *
 * Routing classes:
 *   /v1/...        clean public API, mapped to internal Supabase functions
 *                  via V1_ROUTES below. Headers pass through unchanged.
 *   /functions/... transparent passthrough to the upstream Supabase project.
 *                  Migration courtesy so existing clients keep working while
 *                  they cut over. Dropped after sunset (see Roadmap).
 *   /health        lightweight liveness check served locally by the Worker.
 *                  Does NOT forward , the Worker being reachable is enough
 *                  signal; maintainer infrastructure liveness is checked separately.
 *
 * Anything else returns 404. Closed by default.
 *
 * Wiki: Apps/🚂 Orange Rails/api.orangerails.com , Canonical Gateway/Proposal
 */

export interface Env {
  /** OR Supabase URL , e.g. https://lcdicqalreskibdfxkzb.supabase.co (prod) or the dev ref. Set per environment in wrangler.toml. */
  OR_SUPABASE_URL: string;
}

type V1Route = {
  method: 'GET' | 'POST';
  fn: string;
  /** When set, the public path includes a trailing segment that maps to the upstream subpath. */
  upstreamSuffix?: (rest: string) => string;
};

const V1_ROUTES: Record<string, V1Route> = {
  'POST /v1/platforms/provision':       { method: 'POST', fn: 'or-provision' },
  'GET  /v1/platforms/display':         { method: 'GET',  fn: 'or-platform-display' },
  'POST /v1/link/mint-token':           { method: 'POST', fn: 'or-link-mint-token' },
  'POST /v1/link/complete':             { method: 'POST', fn: 'or-link-complete' },
  'POST /v1/connections/create':        { method: 'POST', fn: 'or-connection-create' },
  'POST /v1/connections/sync':          { method: 'POST', fn: 'or-sync' },
  'GET  /v1/connections/list':          { method: 'GET',  fn: 'or-connection-list' },
  'POST /v1/connections/delete':        { method: 'POST', fn: 'or-connection-delete' },
  'POST /v1/wallets/discover':          { method: 'POST', fn: 'or-discover-wallets' },
  'POST /v1/wallets/source-set':        { method: 'POST', fn: 'or-source-wallets-set' },
  'POST /v1/quiltt/session':            { method: 'POST', fn: 'or-quiltt-session' },
  'POST /v1/quiltt/session-via-widget': { method: 'POST', fn: 'or-quiltt-session-via-widget' },
  'POST /v1/quiltt/accounts':           { method: 'POST', fn: 'or-quiltt-accounts' },
  'POST /v1/quiltt/disconnect':         { method: 'POST', fn: 'or-quiltt-disconnect' },
  'POST /v1/quiltt/sync':               { method: 'POST', fn: 'or-quiltt-sync' },
  'POST /v1/transactions/list':         { method: 'POST', fn: 'or-transactions-list' },
  'GET  /v1/providers':                 { method: 'GET',  fn: 'or-providers' },
  // Truth-data routes , world-gateway has a sub-path per dataset.
  'GET  /v1/truth/precious-metals':           { method: 'GET', fn: 'world-gateway', upstreamSuffix: () => 'precious-metals' },
  'GET  /v1/truth/inflation':                 { method: 'GET', fn: 'world-gateway', upstreamSuffix: () => 'inflation' },
  'GET  /v1/truth/historical-money-prices':   { method: 'GET', fn: 'world-gateway', upstreamSuffix: () => 'historical-money-prices' },
  'GET  /v1/truth/bitcoin-network':           { method: 'GET', fn: 'world-gateway', upstreamSuffix: () => 'bitcoin-network' },
  'GET  /v1/truth/wages':                     { method: 'GET', fn: 'world-gateway', upstreamSuffix: () => 'wages' },
  'GET  /v1/truth/monetary-aggregates':       { method: 'GET', fn: 'world-gateway', upstreamSuffix: () => 'monetary-aggregates' },
  'GET  /v1/truth/commodity-prices':          { method: 'GET', fn: 'world-gateway', upstreamSuffix: () => 'commodity-prices' },
};

function lookupV1(method: string, pathname: string): V1Route | null {
  const key = `${method.padEnd(4)} ${pathname}`;
  return V1_ROUTES[key] ?? null;
}

function forwardHeaders(src: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of src) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'cf-connecting-ip' || lk.startsWith('cf-') || lk === 'x-forwarded-host') continue;
    out.set(k, v);
  }
  return out;
}

async function proxyToSupabase(
  upstreamUrl: string,
  request: Request,
): Promise<Response> {
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers: forwardHeaders(request.headers),
    body: hasBody ? request.body : undefined,
    redirect: 'manual',
  };
  if (hasBody) init.duplex = 'half';
  const upstream = new Request(upstreamUrl, init);
  return fetch(upstream);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'authorization,content-type,x-platform-api-key,x-or-widget-token,x-region',
          'access-control-max-age': '86400',
        },
      });
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'api.orangerails.com' }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.pathname.startsWith('/v1/')) {
      const route = lookupV1(method, url.pathname);
      if (!route) {
        return new Response(JSON.stringify({ error: 'route_not_found', path: url.pathname }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      const suffix = route.upstreamSuffix ? `/${route.upstreamSuffix(url.pathname)}` : '';
      const upstream = new URL(
        `/functions/v1/${route.fn}${suffix}${url.search}`,
        env.OR_SUPABASE_URL,
      ).toString();
      return proxyToSupabase(upstream, request);
    }

    if (url.pathname.startsWith('/functions/')) {
      const upstream = new URL(url.pathname + url.search, env.OR_SUPABASE_URL).toString();
      return proxyToSupabase(upstream, request);
    }

    return new Response(JSON.stringify({ error: 'not_found', path: url.pathname }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  },
};
