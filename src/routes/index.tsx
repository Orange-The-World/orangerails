import { createFileRoute, redirect } from "@tanstack/react-router";

import { resolveRootRedirect } from "../lib/root-redirect";

// The app has no landing page of its own; the marketing site lives in a
// separate repo. A cold visitor hitting "/" (the bare domain, the logo, or the
// 404 page's "Go home" link, which target "/") lands on the public docs index.
// An embedding platform opens the widget at "/" with connect params in the
// query and, for the fragment-handoff flow, credential material in the URL
// fragment (cred_key, widget_token). Both are forwarded to /connect verbatim,
// via a raw href, so neither the query nor the fragment is lost; forwarding by
// route and search alone would drop the fragment and kill the handoff. See
// resolveRootRedirect. Redirect at load so "/" never renders a page of its own.
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    const rawQuery = typeof window !== "undefined" ? window.location.search : "";
    const rawHash = typeof window !== "undefined" ? window.location.hash : "";
    const target = resolveRootRedirect(rawQuery, rawHash);
    if ("href" in target) {
      throw redirect({ href: target.href });
    }
    throw redirect({ to: "/docs" });
  },
});
