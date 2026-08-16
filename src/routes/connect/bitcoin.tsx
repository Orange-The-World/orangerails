/**
 * /connect/bitcoin - backwards-compat redirect to the provider picker.
 *
 * Previously hosted the Bitcoin wallet (xpub/ypub/zpub) setup flow.
 * That setup was moved inline into the provider picker (/providers).
 *
 * External links, bookmarks, and the xpub provider manifest's connectUrl
 * (supabase/functions/_shared/providers/xpub/index.ts) still reference this
 * path; we redirect with the full query string intact rather than 404-ing
 * them. Platform handoff params (platform, app_user_id, app_url) survive
 * unchanged so embedded-app flows still work.
 *
 * See resolveConnectRedirectHref for the redirect logic and its unit tests.
 *
 * DL-1007
 */

import { createFileRoute, redirect } from "@tanstack/react-router";
import { resolveConnectRedirectHref } from "./_connect-redirect";

export const Route = createFileRoute("/connect/bitcoin")({
  beforeLoad: () => {
    const rawSearch =
      typeof window !== "undefined" ? window.location.search : "";
    throw redirect({ href: resolveConnectRedirectHref(rawSearch) });
  },
});
