/**
 * Decide where the bare root "/" should send a request.
 *
 * A cold visitor (the bare app domain, the logo, the 404 page's "Go home"
 * link) has no connect params and belongs on the public docs index. An
 * embedding platform opens the widget at "/" carrying connect params in the
 * query (platform, app_user_id, return_to) and, for the fragment-handoff
 * flow, credential material in the URL fragment (cred_key, widget_token).
 *
 * Both must reach /connect untouched. The query alone is not enough: the
 * fragment carries the credential handoff, and forwarding by route + search
 * would silently drop it, restoring the page but killing the connection. So
 * we forward a raw href that preserves the query AND the fragment verbatim.
 * /connect re-validates its own search on load.
 *
 * We only look at platform and app_user_id to decide embed vs cold visitor;
 * everything else is forwarded as-is rather than reconstructed, so a param or
 * fragment key we do not know about still survives.
 */
export type RootRedirect = { href: string } | { to: "/docs" };

export function resolveRootRedirect(rawQuery: string, rawHash: string): RootRedirect {
  const params = new URLSearchParams(rawQuery);
  const platform = params.get("platform");
  const appUserId = params.get("app_user_id");
  // Non-empty strings only: get() returns null when absent, "" when present
  // but empty, and both are falsy here.
  if (platform && appUserId) {
    return { href: `/connect${rawQuery}${rawHash}` };
  }
  return { to: "/docs" };
}
