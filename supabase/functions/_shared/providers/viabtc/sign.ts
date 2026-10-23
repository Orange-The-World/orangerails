/**
 * ViaBTC pool API request signing.
 *
 * Wiki (https://github.com/viabtc/viapool_api/wiki/api_authentication):
 * HMAC-SHA256 of the GET/DELETE query string (or POST/PUT JSON body) using
 * the account secret as the HMAC key, hex digest, sent as X-SIGNATURE.
 * The query string is signed exactly as sent; order does not matter as
 * long as the signature matches the bytes on the wire.
 *
 * The documented sample vector (same wiki page) is pinned in sign.test.ts.
 */

export function buildQueryString(params: Record<string, string | number | boolean>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${String(value)}`);
  }
  return parts.join("&");
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** HMAC-SHA256 hex digest. Secret is used as UTF-8 bytes, matching the wiki openssl example. */
export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return toHex(sig);
}
