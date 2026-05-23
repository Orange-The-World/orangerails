import { describe, it, expect } from "vitest";
import { computeHmacSha256Hex, timingSafeEqualHex } from "../verify";

describe("computeHmacSha256Hex", () => {
  it("matches RFC 4231 Test Case 1 (key=0x0b*20, body='Hi There')", async () => {
    // RFC 4231 §4.2 — HMAC-SHA-256 with the canonical test vector.
    const key = String.fromCharCode(...new Array(20).fill(0x0b));
    const got = await computeHmacSha256Hex(key, "Hi There");
    expect(got).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });

  it("produces 64-char hex output for arbitrary input", async () => {
    const out = await computeHmacSha256Hex("any-secret", "any body");
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs on a one-byte body change (avalanche)", async () => {
    const a = await computeHmacSha256Hex("k", "payload-a");
    const b = await computeHmacSha256Hex("k", "payload-b");
    expect(a).not.toBe(b);
  });

  it("differs on a one-byte key change", async () => {
    const a = await computeHmacSha256Hex("k1", "same body");
    const b = await computeHmacSha256Hex("k2", "same body");
    expect(a).not.toBe(b);
  });
});

describe("timingSafeEqualHex", () => {
  it("returns true on identical strings", () => {
    expect(timingSafeEqualHex("deadbeef", "deadbeef")).toBe(true);
  });

  it("returns false on different strings of equal length", () => {
    expect(timingSafeEqualHex("deadbeef", "deadbeee")).toBe(false);
  });

  it("returns false on different lengths", () => {
    expect(timingSafeEqualHex("ab", "abcd")).toBe(false);
  });

  it("returns false for non-string inputs", () => {
    // @ts-expect-error — runtime guard test
    expect(timingSafeEqualHex(null, "abcd")).toBe(false);
    // @ts-expect-error — runtime guard test
    expect(timingSafeEqualHex("abcd", undefined)).toBe(false);
  });

  it("returns true on empty strings", () => {
    expect(timingSafeEqualHex("", "")).toBe(true);
  });
});
