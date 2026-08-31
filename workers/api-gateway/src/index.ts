/**
 * api.orangerails.com -- canonical API gateway.
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
 *                  Does NOT forward, the Worker being reachable is enough
 *                  signal; maintainer infrastructure liveness is checked separately.
 *
 * Anything else returns 404. Closed by default.
 *
 * Observability:
 *   Wrapped with @sentry/cloudflare so any thrown exception inside the
 *   fetch handler lands at pulse.orangerails.com (self-hosted GlitchTip,
 *   Sentry wire-compatible). Until SENTRY_DSN is set on the worker's
 *   environment, the wrapper is a no-op and the original handler runs
 *   unchanged.
 *
 * Wiki: maintainer-only proposal doc for the canonical-gateway pattern.
 */

import * as Sentry from "@sentry/cloudflare";

export interface Env {
  /** OR Supabase URL, e.g. https://lcdicqalreskibdfxkzb.supabase.co (prod) or the dev ref. Set per environment in wrangler.toml. */
  OR_SUPABASE_URL: string;
  /**
   * ORBI Supabase project base URL, e.g. https://<ref>.supabase.co.
   * Set as a Cloudflare secret on the production Worker via CF dashboard
   * or `wrangler secret put`; never committed (OR repo is public).
   * Required for /v1/rate forwarding. Returns 503 not_configured if unset.
   */
  ORBI_FUNCTIONS_BASE_URL?: string;
  /** Sentry-compatible DSN for the self-hosted GlitchTip project that catches Worker errors. Public client key by convention; safe to ship. */
  SENTRY_DSN?: string;
  /** Optional release identifier surfaced in Sentry events. Set in CI; defaults to "dev" when unset. */
  SENTRY_RELEASE?: string;
  /** Optional environment label surfaced in Sentry events. */
  SENTRY_ENVIRONMENT?: string;
}

type V1Route = {
  method: "GET" | "POST";
  fn: string;
  /** When set, the public path includes a trailing segment that maps to the upstream subpath. */
  upstreamSuffix?: (rest: string) => string;
  /** When "orbi", this route forwards to ORBI_FUNCTIONS_BASE_URL instead of OR_SUPABASE_URL. */
  target?: "orbi";
};

const V1_ROUTES: Record<string, V1Route> = {
  "POST /v1/platforms/provision": { method: "POST", fn: "or-provision" },
  "GET  /v1/platforms/display": { method: "GET", fn: "or-platform-display" },
  "POST /v1/link/mint-token": { method: "POST", fn: "or-link-mint-token" },
  "POST /v1/link/complete": { method: "POST", fn: "or-link-complete" },
  "POST /v1/connections/create": { method: "POST", fn: "or-connection-create" },
  "POST /v1/connections/sync": { method: "POST", fn: "or-sync" },
  "GET  /v1/connections/list": { method: "GET", fn: "or-connection-list" },
  "POST /v1/connections/delete": { method: "POST", fn: "or-connection-delete" },
  "POST /v1/wallets/discover": { method: "POST", fn: "or-discover-wallets" },
  "POST /v1/wallets/source-set": { method: "POST", fn: "or-source-wallets-set" },
  "POST /v1/quiltt/session": { method: "POST", fn: "or-quiltt-session" },
  "POST /v1/quiltt/session-via-widget": { method: "POST", fn: "or-quiltt-session-via-widget" },
  "POST /v1/quiltt/session-revoke": { method: "POST", fn: "or-quiltt-session-revoke" },
  "POST /v1/quiltt/accounts": { method: "POST", fn: "or-quiltt-accounts" },
  "POST /v1/quiltt/disconnect": { method: "POST", fn: "or-quiltt-disconnect" },
  "POST /v1/quiltt/sync": { method: "POST", fn: "or-quiltt-sync" },
  "POST /v1/transactions/list": { method: "POST", fn: "or-transactions-list" },
  "GET  /v1/providers": { method: "GET", fn: "or-providers" },
  "GET  /v1/platform/config": { method: "GET", fn: "or-platform-bootstrap" },
  "POST /v1/platform/config": { method: "POST", fn: "or-platform-bootstrap" },
  // Truth-data routes, world-gateway has a sub-path per dataset.
  "GET  /v1/truth/precious-metals": {
    method: "GET",
    fn: "world-gateway",
    upstreamSuffix: () => "precious-metals",
  },
  "GET  /v1/truth/inflation": {
    method: "GET",
    fn: "world-gateway",
    upstreamSuffix: () => "inflation",
  },
  "GET  /v1/truth/historical-money-prices": {
    method: "GET",
    fn: "world-gateway",
    upstreamSuffix: () => "historical-money-prices",
  },
  "GET  /v1/truth/bitcoin-network": {
    method: "GET",
    fn: "world-gateway",
    upstreamSuffix: () => "bitcoin-network",
  },
  "GET  /v1/truth/wages": { method: "GET", fn: "world-gateway", upstreamSuffix: () => "wages" },
  "GET  /v1/truth/monetary-aggregates": {
    method: "GET",
    fn: "world-gateway",
    upstreamSuffix: () => "monetary-aggregates",
  },
  "GET  /v1/truth/commodity-prices": {
    method: "GET",
    fn: "world-gateway",
    upstreamSuffix: () => "commodity-prices",
  },
  // ORBI rate API: separate Supabase project from OR's own.
  // Authorization and x-api-key headers pass through unchanged so
  // v1-rate can handle per-consumer key lookup and metering.
  // x-api-key is intentionally absent from the CORS preflight allowlist:
  // server-to-server callers (the expected consumers for key metering)
  // are not CORS-bound. Browser callers must use the authorization header.
  // Do NOT inject any OR Supabase anon or service key here.
  "GET  /v1/rate": { method: "GET", fn: "v1-rate", target: "orbi" },
  "POST /v1/rate": { method: "POST", fn: "v1-rate", target: "orbi" },
};

function lookupV1(method: string, pathname: string): V1Route | null {
  const key = `${method.padEnd(4)} ${pathname}`;
  return V1_ROUTES[key] ?? null;
}

/**
 * Header this gateway sets on every proxied request, carrying the
 * edge-verified client IP downstream. Cloudflare writes cf-connecting-ip
 * at its own edge before this Worker ever runs, so a caller cannot forge
 * it there; this gateway is the only thing that sets x-gateway-verified-ip,
 * and it always overwrites whatever arrived under that name.
 */
export const GATEWAY_VERIFIED_IP_HEADER = "x-gateway-verified-ip";

export function forwardHeaders(src: Headers): Headers {
  // Read before the strip loop below removes it.
  const edgeIp = src.get("cf-connecting-ip");
  const out = new Headers();
  for (const [k, v] of src) {
    const lk = k.toLowerCase();
    if (
      lk === "host" ||
      lk === "cf-connecting-ip" ||
      lk.startsWith("cf-") ||
      lk === "x-forwarded-host" ||
      // Drop any caller-supplied value under our trusted header name so
      // it cannot ride through underneath the real one set below.
      lk === GATEWAY_VERIFIED_IP_HEADER
    )
      continue;
    out.set(k, v);
  }
  // Every function behind this gateway loses cf-connecting-ip (stripped
  // above, since it is a Cloudflare-to-Worker hop header, not something
  // safe to hand to an arbitrary upstream unchanged). Re-issue it under a
  // header name downstream functions can trust. When there is no
  // edge-set IP (e.g. a non-Cloudflare local test), no header is set and
  // downstream code should treat that as "caller unidentified", not as a
  // real value.
  if (edgeIp) out.set(GATEWAY_VERIFIED_IP_HEADER, edgeIp);
  return out;
}

async function proxyToSupabase(upstreamUrl: string, request: Request): Promise<Response> {
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: forwardHeaders(request.headers),
    body: hasBody ? request.body : undefined,
    redirect: "manual",
  };
  if (hasBody) init.duplex = "half";
  const upstream = new Request(upstreamUrl, init);
  return fetch(upstream);
}

const handler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers":
            "authorization,content-type,x-platform-api-key,x-or-api-key,x-or-widget-token,x-region",
          "access-control-max-age": "86400",
        },
      });
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, service: "api.orangerails.com" }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname.startsWith("/v1/")) {
      const route = lookupV1(method, url.pathname);
      if (!route) {
        return new Response(JSON.stringify({ error: "route_not_found", path: url.pathname }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      const baseUrl = route.target === "orbi" ? env.ORBI_FUNCTIONS_BASE_URL : env.OR_SUPABASE_URL;
      if (!baseUrl) {
        return new Response(JSON.stringify({ error: "not_configured", path: url.pathname }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      const suffix = route.upstreamSuffix ? `/${route.upstreamSuffix(url.pathname)}` : "";
      const upstream = new URL(
        `/functions/v1/${route.fn}${suffix}${url.search}`,
        baseUrl,
      ).toString();
      return proxyToSupabase(upstream, request);
    }

    if (url.pathname.startsWith("/functions/")) {
      const upstream = new URL(url.pathname + url.search, env.OR_SUPABASE_URL).toString();
      return proxyToSupabase(upstream, request);
    }

    return new Response(JSON.stringify({ error: "not_found", path: url.pathname }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  },
};

/**
 * Sentry-wrapped export. The withSentry helper from @sentry/cloudflare
 * takes a function that returns the Sentry init options (it gets `env`
 * so we can pull SENTRY_DSN from per-environment wrangler vars) plus
 * the original handler. If SENTRY_DSN is empty or unset the wrapper is
 * a no-op and the original handler runs unchanged, so the Worker keeps
 * serving traffic even when the observability stack is down.
 *
 * tracesSampleRate is 0 (errors only) for the first pass to keep the
 * worker CPU budget tight. The Worker is on Cloudflare's free plan
 * limits; performance tracing can be enabled later if useful.
 *
 * The beforeSend hook here is light because the Worker does not see
 * end-user vault material directly. It does pass through bearer-shaped
 * authorization headers from clients, so we strip the request body
 * (which may contain platform API keys in a POST), the authorization
 * header, and any x-*-api-key shapes before the event leaves the edge.
 */
export default Sentry.withSentry(
  (env: Env) => ({
    // Empty DSN disables the SDK per @sentry/cloudflare v8 source
    // (verified: src/init.ts no-ops when dsn is falsy). Keeps prod
    // serving traffic when pulse.orangerails.com is unreachable.
    dsn: env.SENTRY_DSN ?? "",
    release: env.SENTRY_RELEASE ?? "dev",
    environment: env.SENTRY_ENVIRONMENT ?? "production",
    tracesSampleRate: 0,
    sampleRate: 1,
    // Defense in depth on IP capture even though v8 default is already
    // false; pinning explicitly so a future SDK default flip cannot
    // start sending IPs without us noticing.
    sendDefaultPii: false,
    beforeSend(event: Sentry.ErrorEvent) {
      try {
        if (event.request) {
          if (event.request.url) {
            event.request.url = event.request.url.split("#")[0].split("?")[0];
          }
          delete event.request.data;
          delete event.request.cookies;
          delete event.request.headers;
          delete event.request.query_string;
          // The CF Worker runtime passes the env bindings (SENTRY_DSN,
          // OR_SUPABASE_URL, and any future secrets) on request-like
          // shapes inside the SDK. A future Sentry minor that decides
          // to attach env to event.request would silently leak our
          // upstream secrets back to pulse. Strip it now so the leak
          // never gets a chance.
          delete (event.request as { env?: unknown }).env;
        }
        if (event.user) delete event.user.ip_address;
        delete event.extra;
      } catch {
        return null;
      }
      return event;
    },
  }),
  handler,
);
