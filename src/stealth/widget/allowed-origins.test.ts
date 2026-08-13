/**
 * Unit tests for parseAllowedOrigins.
 *
 * The function accepts an optional raw parameter so these tests exercise
 * the fallback logic directly, without env-var stubbing or module
 * reloading. All four cases run synchronously in the node environment.
 *
 * The two cases CTO requested after DL-0467 / #622:
 *   - undefined raw (env var absent): must yield exactly one default origin.
 *   - empty-string raw (Vite unset substitution): must yield exactly one
 *     default origin, not an empty deny-all Set.
 */

import { describe, expect, it } from "vitest";
import { parseAllowedOrigins, STEALTH_DEFAULT_ORIGIN } from "./allowed-origins";

describe("parseAllowedOrigins", () => {
  it("returns the hardcoded default when the env var is absent (undefined)", () => {
    const result = parseAllowedOrigins(undefined);
    expect(result.size).toBe(1);
    expect(result.has(STEALTH_DEFAULT_ORIGIN)).toBe(true);
  });

  it("returns exactly one origin when the env var is an empty string (Vite unset substitution)", () => {
    // Vite replaces an unset VITE_* var with "" at build time.
    // The || in parseAllowedOrigins must catch this so the allowlist never
    // becomes an empty deny-all Set (which would reject every INIT silently).
    const result = parseAllowedOrigins("");
    expect(result.size).toBe(1);
    expect(result.has(STEALTH_DEFAULT_ORIGIN)).toBe(true);
  });

  it("returns the configured origins when the env var is set", () => {
    const result = parseAllowedOrigins(
      "https://example.com,https://other.example.com",
    );
    expect(result).toEqual(
      new Set(["https://example.com", "https://other.example.com"]),
    );
  });

  it("trims whitespace around each origin", () => {
    const result = parseAllowedOrigins(
      "  https://a.com  ,  https://b.com  ",
    );
    expect(result).toEqual(new Set(["https://a.com", "https://b.com"]));
  });

  // The widget is driven by our own pages (/connect/sparrow, /connect/bitcoin),
  // which post INIT with return_callback_origin set to their own origin. That
  // origin is a deployment hostname and was not in the env var, so the widget
  // refused our own INIT with ORIGIN_NOT_ALLOWED. These pin the runtime
  // self-origin so a hostname nobody remembered to list cannot break our own
  // pages again.
  it("always allows the origin the widget is served from", () => {
    const result = parseAllowedOrigins(
      "https://a.com",
      "https://dev.orangerails.com",
    );
    expect(result.has("https://dev.orangerails.com")).toBe(true);
    expect(result.has("https://a.com")).toBe(true);
    expect(result.size).toBe(2);
  });

  it("allows the self origin even when the env var is unset", () => {
    const result = parseAllowedOrigins("", "https://connect.orangerails.com");
    expect(result.has("https://connect.orangerails.com")).toBe(true);
    expect(result.has(STEALTH_DEFAULT_ORIGIN)).toBe(true);
    expect(result.size).toBe(2);
  });

  it("does not duplicate a self origin the env var already lists", () => {
    const result = parseAllowedOrigins(
      "https://a.com,https://dev.orangerails.com",
      "https://dev.orangerails.com",
    );
    expect(result.size).toBe(2);
  });

  // A sandboxed iframe or a data: URL reports window.location.origin as the
  // literal string "null". Admitting that would allow every opaque origin at
  // once, so it must never become an entry.
  it('refuses the literal "null" opaque origin', () => {
    const result = parseAllowedOrigins("https://a.com", "null");
    expect(result.has("null")).toBe(false);
    expect(result.size).toBe(1);
  });

  it("ignores an absent self origin", () => {
    expect(parseAllowedOrigins("https://a.com", null).size).toBe(1);
    expect(parseAllowedOrigins("https://a.com", undefined).size).toBe(1);
  });
});
