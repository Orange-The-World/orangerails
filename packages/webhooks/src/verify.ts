/**
 * Web Crypto primitives for HMAC-SHA-256 webhook verification.
 *
 * No Node-specific imports — uses globalThis.crypto.subtle so the same
 * code runs in Node 18+, Deno, Bun, Cloudflare Workers, and browsers.
 */

/**
 * Resolve a Web Crypto implementation. Prefers the global (modern Node
 * 20+, Deno, Bun, Workers, browsers). Falls back to `node:crypto`'s
 * `webcrypto` export on Node 18.x where the global is not yet exposed.
 */
let cachedSubtle: SubtleCrypto | null = null;
async function getSubtle(): Promise<SubtleCrypto> {
  if (cachedSubtle) return cachedSubtle;
  const g = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto;
  if (g && g.subtle) {
    cachedSubtle = g.subtle;
    return cachedSubtle;
  }
  // Node 18 path: webcrypto lives in node:crypto. Dynamic import so
  // non-Node runtimes (Deno/Workers/browsers) never touch it.
  const mod = (await import("node:crypto")) as {
    webcrypto: { subtle: SubtleCrypto };
  };
  cachedSubtle = mod.webcrypto.subtle;
  return cachedSubtle;
}

/**
 * Compute hex-encoded HMAC-SHA-256 of `body` keyed by the UTF-8 bytes
 * of `secret`. Mirrors `computeSignature` in OR's
 * `or-webhook-dispatch/index.ts` so dispatch and SDK agree byte-for-byte.
 */
export async function computeHmacSha256Hex(
  secret: string,
  body: string,
): Promise<string> {
  const enc = new TextEncoder();
  const subtle = await getSubtle();
  const key = await subtle.importKey(
    "raw",
    enc.encode(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await subtle.sign(
    "HMAC",
    key,
    enc.encode(body) as BufferSource,
  );
  return bytesToHex(new Uint8Array(sig));
}

/**
 * Constant-time comparison of two hex strings. Returns false immediately
 * on length mismatch (length is not secret). Otherwise XORs every byte
 * pair, so total time is a function of length only, not contents.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] as number).toString(16).padStart(2, "0");
  }
  return out;
}
