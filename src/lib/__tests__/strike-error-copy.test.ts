import { describe, expect, it } from "vitest";
import {
  strikeMarkerToCopy,
  upstreamCodeToCopy,
  upstreamMarkerToCopy,
} from "../strike-error-copy";

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

describe("upstreamMarkerToCopy (plaintext pre-check, before decrypt)", () => {
  it("maps a plaintext CODE:correlationId marker to copy, keeping the reference, no code leak", () => {
    // This is what or-sync writes UNENCRYPTED in sink mode / on encrypt failure.
    const out = upstreamMarkerToCopy("UPSTREAM_AUTH_FAILED:ab12cd34ef567890");
    expect(out).toContain("Your bank disconnected this account");
    expect(out).toContain("(Reference: ab12cd34ef567890)");
    expect(out).not.toContain("UPSTREAM_AUTH_FAILED");
  });

  it("maps the encrypt-failure fallback shape (a bare code, no correlation id)", () => {
    const out = upstreamMarkerToCopy("UPSTREAM_UNAVAILABLE");
    expect(out).toContain("temporarily unreachable");
    expect(out).not.toContain("Reference");
  });

  it("returns null for opaque ciphertext so the caller still runs decrypt", () => {
    // A base64-ish ORK ciphertext never carries a known taxonomy code prefix.
    expect(upstreamMarkerToCopy("q83nZ1p+Vd2f/AbCdEf==:notacode")).toBeNull();
    expect(upstreamMarkerToCopy("SOME_INTERNAL_CODE:deadbeef")).toBeNull();
  });

  it("returns null for an empty value", () => {
    expect(upstreamMarkerToCopy("")).toBeNull();
    expect(upstreamMarkerToCopy("   ")).toBeNull();
  });

  it("never treats an inherited Object property name as a known code", () => {
    // Guards the hasOwnProperty discriminator against prototype keys.
    expect(upstreamMarkerToCopy("toString:deadbeef")).toBeNull();
    expect(upstreamMarkerToCopy("constructor:deadbeef")).toBeNull();
  });

  it("maps every known upstream code as a plaintext marker without leaking the code name", () => {
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
      const out = upstreamMarkerToCopy(`${code}:00ff00ff`);
      expect(out).not.toBeNull();
      expect(out).not.toContain(code);
    }
  });
});

describe("live prod status=error shapes render exact copy (DL-0320 acceptance)", () => {
  // The 7 live prod rows the Auditor verified read-only on the connections
  // table are 6x UPSTREAM_OTHER and 1x UPSTREAM_UNAVAILABLE, all persisted
  // PLAINTEXT as CODE:correlationId. Pin the EXACT customer-facing string,
  // correlation hex included, on the raw-value pre-check path (no decrypt), so
  // any wording drift fails the suite instead of shipping to a customer.
  it("UPSTREAM_OTHER plaintext row renders the exact generic copy with the reference", () => {
    expect(upstreamMarkerToCopy("UPSTREAM_OTHER:00ff00ff")).toBe(
      "We hit an unexpected error syncing this account. Try again in a " +
        "few minutes. If it keeps happening, contact support and quote the " +
        "reference below. (Reference: 00ff00ff)",
    );
  });

  it("UPSTREAM_UNAVAILABLE plaintext row renders the exact copy with the reference", () => {
    expect(upstreamMarkerToCopy("UPSTREAM_UNAVAILABLE:00ff00ff")).toBe(
      "Your bank's service is temporarily unreachable. Try again in a " +
        "few minutes. (Reference: 00ff00ff)",
    );
  });
});
