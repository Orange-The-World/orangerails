// Shared HTTP helpers for Supabase Edge Functions

// Custom headers for OR's auth modes:
//   x-platform-api-key — Plaid-style platform API key for SaaS integrators
//                        (BitBooks V3, BitBooks Personal, future apps)
//   x-or-access-token — DEPRECATED legacy cross-app token; kept temporarily
//                        for backward compat during the platform redesign rollout
const ALLOWED_HEADERS = 'authorization, x-client-info, apikey, content-type, x-platform-api-key, x-or-access-token';
const ALLOWED_METHODS = 'GET, POST, OPTIONS';
const MAX_BODY_BYTES = 1_000_000; // 1 MB

// Static CORS allow-list. Each registered platform that calls OR directly
// from the browser (or-sync, or-transactions-list, etc.) needs its origin
// listed here. The platforms.cors_origin column was added in the
// 20260424120000 migration so this can move to a database-backed lookup
// before the second external platform onboards (see V2-OR-INTEGRATION-PR-SPEC §10).
//
// Add entries by exact origin match (no trailing slash, no wildcards).
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set<string>([
  // BitBooks V3 (existing)
  'https://bitbooks-v3.lovable.app',
  'https://app.bitbooks.com',
  'http://localhost:5173',
  // BitBooks V2 (added 2026-04-24 for thin-slice integration)
  'http://localhost:3000',
  // OrangeRails own /app + Lovable preview
  'https://orangerails.com',
  'https://orangerails-cloud.lovable.app',
]);

export function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin');
  // If the request has a known Origin, echo it. Unknown / missing origins
  // get '*' (callers without credentials still work, e.g. server-side fetch).
  const allowedOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : '*';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Vary': 'Origin',
  };
}

export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}

/**
 * Read request body as text with a hard size cap.
 * Returns null if the body exceeds MAX_BODY_BYTES.
 */
export async function readBoundedText(
  req: Request,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<string | null> {
  const contentLength = req.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    return null;
  }

  if (!req.body) return '';

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        return null;
      }
      chunks.push(value);
    }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}
