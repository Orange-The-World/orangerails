import { describe, expect, it } from "vitest";
import {
  extractDiscoveryErrorMessage,
  isDiscoveryAuthFailure,
} from "../discovery-error";

// ---------------------------------------------------------------------------
// isDiscoveryAuthFailure
// ---------------------------------------------------------------------------

describe("isDiscoveryAuthFailure", () => {
  it("returns true for UPSTREAM_AUTH_FAILED (credentials rejected)", () => {
    const body = JSON.stringify({
      error_code: "UPSTREAM_AUTH_FAILED",
      body: "Your credentials were not accepted.",
    });
    expect(isDiscoveryAuthFailure(body)).toBe(true);
  });

  it("returns false for UPSTREAM_UNAVAILABLE (exchange unreachable)", () => {
    const body = JSON.stringify({
      error_code: "UPSTREAM_UNAVAILABLE",
      body: "The exchange is temporarily unavailable.",
    });
    expect(isDiscoveryAuthFailure(body)).toBe(false);
  });

  it("returns false for UPSTREAM_RATE_LIMITED (exchange unreachable / transient)", () => {
    const body = JSON.stringify({
      error_code: "UPSTREAM_RATE_LIMITED",
      body: "Rate limit exceeded.",
    });
    expect(isDiscoveryAuthFailure(body)).toBe(false);
  });

  it("returns false for any other upstream code", () => {
    for (const code of [
      "UPSTREAM_BAD_REQUEST",
      "UPSTREAM_PARSE_FAILED",
      "ADAPTER_CONFIG_ERROR",
      "UPSTREAM_OTHER",
    ]) {
      expect(isDiscoveryAuthFailure(JSON.stringify({ error_code: code }))).toBe(
        false,
      );
    }
  });

  it("returns false when error_code is absent (fallback 500 path)", () => {
    // The edge function omits error_code on the generic catch branch.
    // Absence must not be treated as a confirmed auth failure.
    const body = JSON.stringify({ body: "Internal server error." });
    expect(isDiscoveryAuthFailure(body)).toBe(false);
  });

  it("returns false for an unrecognised code value", () => {
    const body = JSON.stringify({ error_code: "SOME_FUTURE_CODE" });
    expect(isDiscoveryAuthFailure(body)).toBe(false);
  });

  it("returns false for non-JSON response bodies", () => {
    expect(isDiscoveryAuthFailure("")).toBe(false);
    expect(isDiscoveryAuthFailure("Service Unavailable")).toBe(false);
    expect(isDiscoveryAuthFailure("<html>502 Bad Gateway</html>")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractDiscoveryErrorMessage
// ---------------------------------------------------------------------------

describe("extractDiscoveryErrorMessage", () => {
  it("prefers body over title and error", () => {
    const raw = JSON.stringify({
      body: "Preferred message.",
      title: "Title message.",
      error: "Error message.",
    });
    expect(extractDiscoveryErrorMessage(422, raw)).toBe("Preferred message.");
  });

  it("falls back to title when body is absent", () => {
    const raw = JSON.stringify({ title: "Title message." });
    expect(extractDiscoveryErrorMessage(422, raw)).toBe("Title message.");
  });

  it("falls back to error when body and title are absent", () => {
    const raw = JSON.stringify({ error: "Error message." });
    expect(extractDiscoveryErrorMessage(422, raw)).toBe("Error message.");
  });

  it("falls back to status-based message for non-JSON", () => {
    const msg = extractDiscoveryErrorMessage(503, "Service Unavailable");
    expect(msg).toContain("503");
  });

  it("falls back to status-based message when all string fields are absent", () => {
    const msg = extractDiscoveryErrorMessage(500, JSON.stringify({}));
    expect(msg).toContain("500");
  });

  it("does not echo a raw error_code to the user", () => {
    const raw = JSON.stringify({ error_code: "UPSTREAM_AUTH_FAILED" });
    const msg = extractDiscoveryErrorMessage(422, raw);
    // No body/title/error field, so it falls back to the status message.
    // The raw taxonomy code must not surface to the customer.
    expect(msg).not.toContain("UPSTREAM_AUTH_FAILED");
    expect(msg).toContain("422");
  });
});
