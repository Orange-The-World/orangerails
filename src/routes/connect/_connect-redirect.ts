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
  // Forward every query param unchanged. /providers validates app_url on mount
  // and shows a refusal alert for untrusted or malformed origins (DL-0426).
  // platform and app_user_id are preserved for future picker use.
  return `/providers${rawSearch}`;
}
