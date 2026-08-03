import { describe, it, expect } from "vitest";
import { extractDiscoveryErrorMessage } from "./discovery-error";

/**
 * Guards the app.tsx discovery path: on any non-ok discovery response,
 * extractDiscoveryErrorMessage must return a displayable error string,
 * never the "Connection added" success copy that the handler emits before
 * discovery runs.
 *
 * Failing-before: before discovery-error.ts existed, the handler had no
 * function to call and the notice was hardcoded to "Connection added..." for
 * all outcomes. This import itself throws "Cannot find module './discovery-error'"
 * on a commit without the fix.
 */

const SUCCESS_STRING = "Connection added";

describe("extractDiscoveryErrorMessage", () => {
  it("never returns the success string for any non-ok response", () => {
    const cases: Array<{ status: number; raw: string }> = [
      { status: 401, raw: JSON.stringify({ body: "Invalid API key" }) },
      { status: 422, raw: JSON.stringify({ title: "Credentials rejected" }) },
      { status: 422, raw: JSON.stringify({ error: "UPSTREAM_AUTH_FAILED" }) },
      { status: 429, raw: JSON.stringify({ body: "Rate limited" }) },
      { status: 503, raw: "Service Unavailable" },
      { status: 500, raw: "" },
    ];
    for (const { status, raw } of cases) {
      const msg = extractDiscoveryErrorMessage(status, raw);
      expect(msg).not.toContain(SUCCESS_STRING);
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  it("returns body field when present", () => {
    const msg = extractDiscoveryErrorMessage(
      422,
      JSON.stringify({ body: "Wrong credentials" }),
    );
    expect(msg).toBe("Wrong credentials");
  });

  it("falls back to title when body absent", () => {
    const msg = extractDiscoveryErrorMessage(
      422,
      JSON.stringify({ title: "Auth failed" }),
    );
    expect(msg).toBe("Auth failed");
  });

  it("falls back to error field when body and title absent", () => {
    const msg = extractDiscoveryErrorMessage(
      422,
      JSON.stringify({ error: "Bad API key" }),
    );
    expect(msg).toBe("Bad API key");
  });

  it("uses status-based fallback for non-JSON body", () => {
    const msg = extractDiscoveryErrorMessage(503, "Service Unavailable");
    expect(msg).toBe(
      "Wallet discovery failed (503). Check your credentials and try again.",
    );
  });

  it("uses status-based fallback for empty body", () => {
    const msg = extractDiscoveryErrorMessage(500, "");
    expect(msg).toBe(
      "Wallet discovery failed (500). Check your credentials and try again.",
    );
  });
});
