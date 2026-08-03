import { describe, it, expect } from "vitest";
import { resolveTargetOrigin } from "./connect-origin";

const ALLOWED = new Set(["https://app.bitbooks.com", "https://example.com"]);

describe("resolveTargetOrigin", () => {
  it("returns the origin when return_to is valid and allowed", () => {
    expect(resolveTargetOrigin("https://app.bitbooks.com/callback", ALLOWED)).toBe(
      "https://app.bitbooks.com",
    );
    expect(resolveTargetOrigin("https://example.com/deep/path?q=1", ALLOWED)).toBe(
      "https://example.com",
    );
  });

  it("returns null when return_to is unparseable (was the wildcard branch)", () => {
    expect(resolveTargetOrigin("not a url", ALLOWED)).toBeNull();
    expect(resolveTargetOrigin(":::invalid:::", ALLOWED)).toBeNull();
    expect(resolveTargetOrigin("javascript:alert(1)", ALLOWED)).toBeNull();
  });

  it("returns null when return_to is undefined or empty", () => {
    expect(resolveTargetOrigin(undefined, ALLOWED)).toBeNull();
    expect(resolveTargetOrigin("", ALLOWED)).toBeNull();
  });

  it("returns null when origin is not in the allowlist", () => {
    expect(resolveTargetOrigin("https://evil.com/steal", ALLOWED)).toBeNull();
    expect(resolveTargetOrigin("https://sub.bitbooks.com/ok", ALLOWED)).toBeNull();
  });

  it("returns null when the allowlist is empty (no implicit wildcard)", () => {
    expect(resolveTargetOrigin("https://app.bitbooks.com/callback", new Set())).toBeNull();
  });
});
