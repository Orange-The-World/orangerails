/**
 * Shared redirect logic for the legacy /connect/bitcoin and /connect/sparrow
 * routes (DL-1007). Both routes now redirect to /providers (the picker) with
 * the query string preserved verbatim.
 *
 * Extracted as a pure function so the routing decision can be unit-tested
 * without a running router or browser environment.
 */

/**
 * Returns the redirect href for a legacy connect route.
 *
 * @param rawSearch - window.location.search (e.g. "?platform=bitbooks&app_user_id=u123")
 * @returns The full href to redirect to, e.g. "/providers?platform=bitbooks&app_user_id=u123"
 */
export function resolveConnectRedirectHref(rawSearch: string): string {
  // Forward every query param unchanged. The picker at /providers reads
  // platform, app_user_id, app_url, and any other handoff params on mount.
  return `/providers${rawSearch}`;
}
