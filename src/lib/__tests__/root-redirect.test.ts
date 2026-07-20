import { describe, it, expect } from "vitest";

import { resolveRootRedirect } from "../root-redirect";

// This class of routing bug is invisible to any HTTP-level check: the broken
// path returns 200 and renders a client-side fallback. So the guard has to be
// asserted at the routing-decision level, which is what these cover.
describe("resolveRootRedirect", () => {
  it("forwards a real embed (platform + app_user_id) to /connect with every param preserved", () => {
    const search = {
      platform: "example-platform",
      app_user_id: "user_example_id",
      return_to: "https://app.example.com/settings",
      widget_token: "wt_example",
    };

    const result = resolveRootRedirect(search);

    expect(result.to).toBe("/connect");
    if (result.to === "/connect") {
      // The full search survives the redirect, not just the two gate params.
      expect(result.search).toEqual(search);
      expect(result.search.platform).toBe("example-platform");
      expect(result.search.app_user_id).toBe("user_example_id");
      expect(result.search.return_to).toBe("https://app.example.com/settings");
      expect(result.search.widget_token).toBe("wt_example");
    }
  });

  it("sends a cold visitor with no params to /docs", () => {
    expect(resolveRootRedirect({})).toEqual({ to: "/docs" });
  });

  it("does not forward when only one of the two required params is present", () => {
    expect(resolveRootRedirect({ platform: "example-platform" })).toEqual({ to: "/docs" });
    expect(resolveRootRedirect({ app_user_id: "user_example_id" })).toEqual({ to: "/docs" });
  });

  it("treats empty-string params as absent", () => {
    expect(resolveRootRedirect({ platform: "", app_user_id: "" })).toEqual({ to: "/docs" });
  });
});
