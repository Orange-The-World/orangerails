/**
 * Parses the error catalog returned by or-discover-wallets on a non-ok
 * response and returns a human-readable message for the in-app notice.
 *
 * The edge function returns a JSON body with one of: body, title, or error.
 * connect.tsx already follows this contract (serverDiscover); this helper
 * gives the app.tsx path the same behaviour and a unit-testable seam.
 *
 * @param status  HTTP status code from the discovery response.
 * @param rawText Raw response body text (may be non-JSON).
 * @returns       A displayable error string, never the old "Connection added" text.
 */
/**
 * Returns true only when the discovery error response signals a confirmed
 * authentication failure (error_code === 'UPSTREAM_AUTH_FAILED').
 *
 * All other outcomes, including unrecognised codes, missing codes, and
 * non-JSON bodies, return false so that transient failures (rate limiting,
 * upstream outages) and unknown errors never trigger a destructive action on
 * the connection row. Treat a missing or unrecognised code as not a confirmed
 * authentication failure and leave the row untouched, per the precondition
 * documented in https://github.com/Orange-The-World/orangerails/issues/406
 *
 * @param rawText Raw response body text (may be non-JSON).
 */
export function isDiscoveryAuthFailure(rawText: string): boolean {
  try {
    const body = JSON.parse(rawText) as Record<string, unknown>;
    return body.error_code === "UPSTREAM_AUTH_FAILED";
  } catch {
    return false;
  }
}

export function extractDiscoveryErrorMessage(status: number, rawText: string): string {
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    /* non-JSON response -- fall through to the status-based fallback */
  }
  return (
    (typeof body.body === "string" ? body.body : undefined) ??
    (typeof body.title === "string" ? body.title : undefined) ??
    (typeof body.error === "string" ? body.error : undefined) ??
    `Wallet discovery failed (${status}). Check your credentials and try again.`
  );
}
