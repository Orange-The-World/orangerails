/**
 * Return-to origin validation for the /connect widget.
 *
 * The widget postMessages results back to the opener after the user
 * completes or cancels the flow. The targetOrigin for postMessage must
 * never be "*": a wildcard lets any window in the tab tree intercept a
 * payload that may carry connection IDs and wallet metadata.
 *
 * This module validates return_to against the same allowlist
 * (VITE_OR_STEALTH_ALLOWED_ORIGINS) used by the Stealth widget
 * (src/stealth/widget/App.tsx) and the Sparrow page
 * (src/routes/connect/sparrow.tsx). Callers pass the compiled set in so
 * the function stays pure and testable without import.meta.env.
 */

/**
 * Parse return_to and validate its origin against the registered allowlist.
 *
 * Returns the origin string (e.g. "https://app.example.com") when the URL
 * is well-formed and its origin appears in allowedOrigins.
 *
 * Returns null when:
 *   - return_to is undefined or empty
 *   - return_to is not a parseable URL (the branch that previously produced "*")
 *   - the parsed origin is not in allowedOrigins
 *
 * Never returns "*". Callers must treat null as fail-closed and skip the
 * postMessage rather than falling back to a wildcard targetOrigin.
 */
export function resolveTargetOrigin(
  returnTo: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): string | null {
  if (!returnTo) return null;
  let origin: string;
  try {
    origin = new URL(returnTo).origin;
  } catch {
    return null;
  }
  if (!allowedOrigins.has(origin)) return null;
  return origin;
}
