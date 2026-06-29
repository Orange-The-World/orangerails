// Shared HTTP helpers for Supabase Edge Functions

// Custom headers for OR's auth modes:
//   x-platform-api-key , Plaid-style platform API key for SaaS integrators
const ALLOWED_HEADERS = "authorization, x-client-info, apikey, content-type, x-platform-api-key";
const ALLOWED_METHODS = "GET, POST, OPTIONS";
const MAX_BODY_BYTES = 1_000_000; // 1 MB

// Static CORS allow-list , covers only Orange Rails-owned origins and local
// development hosts. Customer- and integrator-specific origins are validated
// at runtime via the `platforms.cors_origin` DB lookup (see the
// 20260424120000 migration). Add entries here only for public Orange Rails
// properties.
//
// Add entries by exact origin match (no trailing slash, no wildcards).
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set<string>([
  "https://orangerails.com",
  "https://dev.orangerails.com",
  "https://app.orangerails.com",
  "https://connect.orangerails.com", // /connect Link widget popup
  "https://orangerails.dev",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5180",
  "http://localhost:5181",
]);

export function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  // Audit 2026-05-16 finding #6: do not fall back to '*' for unknown
  // origins. Browsers reject cross-origin responses without an explicit
  // Allow-Origin match; server-to-server callers don't enforce CORS so
  // they keep working. The only case where '*' is correct is a fully
  // public endpoint with no auth (or-providers, or-platform-display) ,
  // those handlers should call buildPublicCorsHeaders explicitly.
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    Vary: "Origin",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

/**
 * For endpoints that are intentionally public (no auth, anonymous fetch).
 * Returns Access-Control-Allow-Origin: * regardless of the request origin.
 * Use sparingly , only on or-providers and or-platform-display today.
 */
export function buildPublicCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
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
      "Content-Type": "application/json",
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
  const contentLength = req.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    return null;
  }

  if (!req.body) return "";

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
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
