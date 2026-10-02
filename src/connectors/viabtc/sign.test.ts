import { describe, expect, it } from "vitest";

import { buildQueryString, hmacSha256Hex } from "./sign";

const SAMPLE_SECRET = "d186ababcb0eb1f6af5c1519424f462b84c631f86c06309992ae1f15604668b0";
const SAMPLE_QUERY = "coin=BTC&amount=1.0&tonce=1513746038205";
const SAMPLE_DIGEST = "4a1c9e4c73629b62fd999cbbcd2bc8b87a07f1791ae61ba576427f820dd3bc59";

describe("ViaBTC signing", () => {
  it("matches the wiki HMAC-SHA256 sample vector", () => {
    expect(hmacSha256Hex(SAMPLE_SECRET, SAMPLE_QUERY)).toBe(SAMPLE_DIGEST);
  });

  it("buildQueryString preserves insertion order", () => {
    expect(buildQueryString({ coin: "BTC", amount: "1.0", tonce: 1513746038205 })).toBe(SAMPLE_QUERY);
  });
});
