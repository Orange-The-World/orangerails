/**
 * ViaBTC signing tests. The hex digest is the wiki's own sample vector
 * (api_authentication page, cloned 2026-09-15).
 *
 *   echo -n 'coin=BTC&amount=1.0&tonce=1513746038205' \
 *   | openssl dgst -sha256 -hmac '<sample secret>'
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/_shared/providers/viabtc/sign.test.ts
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildQueryString, hmacSha256Hex } from "./sign.ts";

const SAMPLE_SECRET = "d186ababcb0eb1f6af5c1519424f462b84c631f86c06309992ae1f15604668b0";
const SAMPLE_QUERY = "coin=BTC&amount=1.0&tonce=1513746038205";
const SAMPLE_DIGEST = "4a1c9e4c73629b62fd999cbbcd2bc8b87a07f1791ae61ba576427f820dd3bc59";

Deno.test("HMAC-SHA256 matches the ViaBTC wiki sample vector", async () => {
  assertEquals(await hmacSha256Hex(SAMPLE_SECRET, SAMPLE_QUERY), SAMPLE_DIGEST);
});

Deno.test("buildQueryString preserves insertion order and stringifies values", () => {
  assertEquals(
    buildQueryString({ coin: "BTC", amount: "1.0", tonce: 1513746038205 }),
    SAMPLE_QUERY,
  );
});

Deno.test("a different secret does not produce the wiki digest", async () => {
  const other = await hmacSha256Hex("not-the-sample-secret", SAMPLE_QUERY);
  assertEquals(other === SAMPLE_DIGEST, false);
});
