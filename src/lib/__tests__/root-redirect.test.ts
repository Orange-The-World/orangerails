import { describe, it, expect } from "vitest";

import { resolveRootRedirect } from "../root-redirect";

// This class of routing bug is invisible to any HTTP-level check: the broken
// path returns 200 and renders a client-side fallback. And the redirect must
// carry the URL fragment, which holds the credential handoff (cred_key,
// widget_token), not just the query. Both are asserted here at the
// routing-decision level. Placeholder values only.
describe("resolveRootRedirect", () => {
  it("forwards a real embed to /connect preserving both the query and the fragment", () => {
    const rawQuery =
      "?platform=example-platform&app_user_id=user_example_id&provider=blink&return_to=https%3A%2F%2Fapp.example.com%2Fdashboard";
    const rawHash = "#cred_key=example_cred_key&widget_token=example_widget_token";

    const result = resolveRootRedirect(rawQuery, rawHash);

    expect("href" in result).toBe(true);
    if ("href" in result) {
      expect(result.href).toBe(`/connect${rawQuery}${rawHash}`);
      // The fragment carries the credential handoff and must survive verbatim.
      expect(result.href).toContain("#cred_key=example_cred_key");
      expect(result.href).toContain("widget_token=example_widget_token");
      // The query survives too, including the encoded return_to.
      expect(result.href).toContain("platform=example-platform");
      expect(result.href).toContain("return_to=https%3A%2F%2Fapp.example.com%2Fdashboard");
    }
  });

  it("preserves the fragment when the credentials arrive only in the fragment", () => {
    const result = resolveRootRedirect("?platform=p&app_user_id=u", "#cred_key=k&widget_token=t");
    expect(result).toEqual({ href: "/connect?platform=p&app_user_id=u#cred_key=k&widget_token=t" });
  });

  it("sends a cold visitor with no params to /docs", () => {
    expect(resolveRootRedirect("", "")).toEqual({ to: "/docs" });
  });

  it("does not forward when only one of the two required params is present", () => {
    expect(resolveRootRedirect("?platform=example-platform", "")).toEqual({ to: "/docs" });
    expect(resolveRootRedirect("?app_user_id=user_example_id", "")).toEqual({ to: "/docs" });
  });

  it("treats empty-string params as absent", () => {
    expect(resolveRootRedirect("?platform=&app_user_id=", "")).toEqual({ to: "/docs" });
  });
});
