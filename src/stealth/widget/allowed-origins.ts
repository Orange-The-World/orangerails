/**
 * Allowed-origins resolution for the Stealth Sync widget.
 *
 * Extracted from App.tsx so the fallback logic can be unit-tested without
 * importing React or JSX. The vitest config runs in the node environment
 * and only picks up *.test.ts files, so this must stay plain TypeScript.
 *
 * parseAllowedOrigins accepts an optional raw parameter so tests can
 * exercise the fallback directly, without env-var stubbing or module
 * reloading.
 */

/**
 * Hard-coded floor: the origin that is always in the allowlist when the
 * env var is absent or empty. A domain change must be a config change,
 * not a code change, so production should always carry
 * VITE_OR_STEALTH_ALLOWED_ORIGINS explicitly.
 */
export const STEALTH_DEFAULT_ORIGIN = "https://app.orangerails.com";

/**
 * Parse the allowed-origins allowlist.
 *
 * @param raw  Comma-separated string of allowed origins. Defaults to
 *             import.meta.env.VITE_OR_STEALTH_ALLOWED_ORIGINS.
 *
 *             Falls back to STEALTH_DEFAULT_ORIGIN when raw is falsy
 *             (undefined or "") -- this covers both the truly-absent case
 *             and the empty string Vite substitutes for an unset VITE_*
 *             var at build time.
 *
 * @param selfOrigin  The origin the widget itself is served from, normally
 *             window.location.origin. When given it is always allowed, on
 *             top of whatever the env var lists.
 *
 *             Why this is safe: a same-origin parent is not a third party we
 *             are deciding whether to trust. It can already reach into this
 *             document directly, read its DOM and call into it, with or
 *             without postMessage. The allowlist exists to keep CROSS-origin
 *             embedders out, and refusing our own origin buys no security
 *             while breaking every page we serve ourselves.
 *
 *             Why it is needed: our own pages drive this widget. Both
 *             /connect/sparrow and /connect/bitcoin open it and post
 *             OR_STEALTH_INIT with return_callback_origin set to their own
 *             origin. That origin is a deployment hostname, so it has to be
 *             listed in the env var on every environment or the widget
 *             refuses our own INIT with ORIGIN_NOT_ALLOWED. It was not
 *             listed, which is why Launch Stealth Sync failed for signed-in
 *             OrangeRails users. Deriving it at runtime makes the widget
 *             correct on any hostname without a config change, and a
 *             hostname we forget to list can no longer break our own pages.
 *
 *             Pass null or omit it in tests and in any caller that wants the
 *             configured list alone.
 */
export function parseAllowedOrigins(
  raw: string | undefined = import.meta.env
    .VITE_OR_STEALTH_ALLOWED_ORIGINS as string | undefined,
  selfOrigin?: string | null,
): ReadonlySet<string> {
  const resolved = raw || STEALTH_DEFAULT_ORIGIN;
  const origins = resolved
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // Guard against the "null" string: a document with an opaque origin
  // (sandboxed iframe, data: URL) reports window.location.origin as the
  // literal "null", which must never become an allowlist entry.
  if (selfOrigin && selfOrigin !== "null") {
    origins.push(selfOrigin);
  }
  return new Set(origins);
}

export function isAllowedOrigin(
  origin: string,
  allowlist: ReadonlySet<string>,
): boolean {
  return allowlist.has(origin);
}
