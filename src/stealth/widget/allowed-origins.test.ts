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
});
