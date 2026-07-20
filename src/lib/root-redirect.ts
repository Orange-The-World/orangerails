/**
 * Decide where the bare root "/" should send a request.
 *
 * A cold visitor (the bare app domain, the logo, the 404 page's "Go home"
 * link) has no connect params and belongs on the public docs index. An
 * embedding platform opens the widget at "/" carrying connect params
 * (platform and app_user_id, usually return_to and widget_token as well);
 * those must reach /connect with every param preserved, or the widget renders
 * in its missing-params state, which is the dead end the user hits today.
 *
 * A prior change removed this branch on the premise that no real caller sends
 * connect params to "/". At least one integrator does, so the branch is
 * required rather than dead code. We have integrators whose code we cannot
 * see, so both intents (cold visitors to docs, embeds to the widget) must be
 * satisfied at once.
 */
export type RootRedirect = { to: "/connect"; search: Record<string, unknown> } | { to: "/docs" };

export function resolveRootRedirect(search: Record<string, unknown>): RootRedirect {
  const hasPlatform = typeof search.platform === "string" && search.platform.length > 0;
  const hasAppUserId = typeof search.app_user_id === "string" && search.app_user_id.length > 0;
  if (hasPlatform && hasAppUserId) {
    return { to: "/connect", search };
  }
  return { to: "/docs" };
}
