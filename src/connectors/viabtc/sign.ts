/**
 * ViaBTC HMAC-SHA256 request signing. Wiki sample vector is pinned in sign.test.ts.
 */

import { createHmac } from "node:crypto";

export function buildQueryString(params: Record<string, string | number | boolean>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${String(value)}`);
  }
  return parts.join("&");
}

export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}
