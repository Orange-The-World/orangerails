import { describe, expect, it } from "vitest";
import { strikeMarkerToCopy, upstreamCodeToCopy } from "../strike-error-copy";

describe("upstreamCodeToCopy", () => {
  it("maps a known code to plain-English copy and keeps the reference visible", () => {
    const out = upstreamCodeToCopy("UPSTREAM_AUTH_FAILED:ab12cd34ef567890");
    expect(out).toContain("Your bank disconnected this account");
    expect(out).toContain("(Reference: ab12cd34ef567890)");
    // The raw taxonomy code name must never reach the customer.
    expect(out).not.toContain("UPSTREAM_AUTH_FAILED");
  });

  it("omits the reference when the code has no correlation id", () => {
    const out = upstreamCodeToCopy("UPSTREAM_RATE_LIMITED");
    expect(out).toContain("Your bank is briefly busy");
    expect(out).not.toContain("Reference");
  });

  it("falls back to the generic message for an unmapped code, never echoing the code name", () => {
    const out = upstreamCodeToCopy("SOME_INTERNAL_CODE:deadbeef");
    expect(out).toContain("We hit an unexpected error");
    expect(out).toContain("(Reference: deadbeef)");
    expect(out).not.toContain("SOME_INTERNAL_CODE");
  });

  it("does not treat a non-hex segment as a reference", () => {
    const out = upstreamCodeToCopy("UPSTREAM_OTHER:not a real ref");
    expect(out).toContain("We hit an unexpected error");
    expect(out).not.toContain("Reference");
    expect(out).not.toContain("not a real ref");
  });

  it("returns the generic message for an empty error", () => {
    expect(upstreamCodeToCopy("")).toContain("We hit an unexpected error");
  });

  it("maps every known upstream code without leaking the code name", () => {
    const codes = [
      "UPSTREAM_AUTH_FAILED",
      "UPSTREAM_RATE_LIMITED",
      "UPSTREAM_UNAVAILABLE",
      "UPSTREAM_BAD_REQUEST",
      "UPSTREAM_PARSE_FAILED",
      "ADAPTER_CONFIG_ERROR",
      "UPSTREAM_OTHER",
    ];
    for (const code of codes) {
      const out = upstreamCodeToCopy(`${code}:00ff00ff`);
      expect(out).not.toContain(code);
      expect(out.length).toBeGreaterThan(0);
    }
  });
});

describe("strikeMarkerToCopy", () => {
  it("maps the scope-missing marker prefix to actionable copy", () => {
    const out = strikeMarkerToCopy("STRIKE_SCOPE_MISSING_partner.webhooks.manage");
    expect(out).toContain("webhooks.manage");
  });

  it("returns null for anything that is not a known Strike marker", () => {
    expect(strikeMarkerToCopy("UPSTREAM_OTHER:deadbeef")).toBeNull();
  });
});
