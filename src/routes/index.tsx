import { createFileRoute, redirect } from "@tanstack/react-router";

import { resolveRootRedirect } from "../lib/root-redirect";

// The app has no landing page of its own; the marketing site lives in a
// separate repo. A cold visitor hitting "/" (the bare domain, the logo, or
// the 404 page's "Go home" link, which target "/") lands on the public docs
// index. But an embedding platform opens the widget at "/" carrying connect
// params (platform, app_user_id, usually return_to and widget_token); those
// are forwarded to /connect with the full search preserved, or the widget
// would render in its missing-params state. See resolveRootRedirect for the
// split. Redirect at load so "/" never renders a page of its own.
export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): Record<string, unknown> => search,
  beforeLoad: ({ search }) => {
    const target = resolveRootRedirect(search);
    if (target.to === "/connect") {
      // /connect's validateSearch keeps only its declared keys (platform,
      // app_user_id, provider, return_to, widget_token, defer_cred_key,
      // institution), so any other param sent to "/" is dropped here. That
      // key list is a compatibility contract with integrators whose code we
      // cannot see: adding a key is safe, removing one breaks a caller
      // silently.
      throw redirect({ to: "/connect", search: target.search });
    }
    throw redirect({ to: "/docs" });
  },
});
