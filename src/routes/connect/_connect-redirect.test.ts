/**
 * Unit tests for _connect-redirect.ts (DL-1007).
 *
 * Guards that /connect/bitcoin and /connect/sparrow redirect to /providers
 * with the full query string preserved. The critical invariant: platform
 * handoff params (platform, app_user_id, app_url) must reach the picker
 * verbatim so embedded-app handoffs survive the navigation.
 */

import { describe, it, expect } from "vitest";
import { resolveConnectRedirectHref } from "./_connect-redirect";

describe("resolveConnectRedirectHref (/connect/bitcoin and /connect/sparrow -> /providers)", () => {
  it("redirects to bare /providers when there are no query params", () => {
    expect(resolveConnectRedirectHref("")).toBe("/providers");
  });

  it("carries a single query param to /providers", () => {
    expect(resolveConnectRedirectHref("?platform=bitbooks")).toBe(
      "/providers?platform=bitbooks",
    );
  });

  it("carries all handoff params to /providers verbatim", () => {
    const qs =
      "?platform=bitbooks&app_user_id=u123&app_url=https%3A%2F%2Fapp.example.com";
    expect(resolveConnectRedirectHref(qs)).toBe(`/providers${qs}`);
  });

  it("preserves param order and percent-encoding unchanged", () => {
    const qs = "?platform=bb&app_user_id=u999&return_to=https%3A%2F%2Fexample.com%2Fdash";
    expect(resolveConnectRedirectHref(qs)).toBe(`/providers${qs}`);
  });

  it("does not double-encode or strip the leading question mark", () => {
    const qs = "?a=1&b=2&c=3";
    expect(resolveConnectRedirectHref(qs)).toMatch(/^\/providers\?a=1/);
    expect(resolveConnectRedirectHref(qs)).toBe("/providers?a=1&b=2&c=3");
  });
});
