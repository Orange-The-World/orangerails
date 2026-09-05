/**
 * /connect/$provider -- catch-all redirect for path-based provider entry.
 *
 * The widget's canonical URL for generic providers is:
 *   /connect?provider={slug}&platform=...&app_user_id=...&...
 *
 * Consumer apps may navigate to path-based URLs
 *   /connect/blink, /connect/strike, ...
 * which previously fell through to a 404 / error page.
 *
 * This route intercepts any /connect/{slug} that is NOT a concrete named
 * route (quiltt, sparrow, stealth -- those are registered separately and
 * take precedence in TanStack Router's matching) and redirects to the
 * generic /connect?provider={slug} form, forwarding all query params.
 *
 * Adding a new provider to Orange Rails automatically works via this
 * redirect: no per-provider route file needed unless the provider has a
 * custom link flow (like Quiltt or Sparrow).
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

interface ConnectSearch {
  widget_token?: string;
  platform?: string;
  app_user_id?: string;
  provider?: string;
  return_to?: string;
  defer_cred_key?: string;
  institution?: string;
}

export const Route = createFileRoute("/connect/$provider")({
  validateSearch: (search: Record<string, unknown>): ConnectSearch => ({
    platform: typeof search.platform === "string" ? search.platform : undefined,
    app_user_id: typeof search.app_user_id === "string" ? search.app_user_id : undefined,
    provider: typeof search.provider === "string" ? search.provider : undefined,
    return_to: typeof search.return_to === "string" ? search.return_to : undefined,
    widget_token: typeof search.widget_token === "string" ? search.widget_token : undefined,
    defer_cred_key:
      typeof search.defer_cred_key === "string" ? search.defer_cred_key : undefined,
    institution: typeof search.institution === "string" ? search.institution : undefined,
  }),
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/connect",
      search: { ...search, provider: params.provider },
    });
  },
});
