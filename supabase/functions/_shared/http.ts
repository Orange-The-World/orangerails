// Shared HTTP helpers for Supabase Edge Functions

// x-or-access-token allows cross-app callers (BitBooks V3, Personal) to
// authenticate to or-sync without a Supabase JWT. Other functions ignore it.
const ALLOWED_HEADERS = 'authorization, x-client-info, apikey, content-type, x-or-access-token';
const ALLOWED_METHODS = 'GET, POST, OPTIONS';
const MAX_BODY_BYTES = 1_000_000; // 1 MB

export function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '*';
  return {
    'Access-Control-Allow-Origin': origin,
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
