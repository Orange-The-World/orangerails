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
 */
export function parseAllowedOrigins(
  raw: string | undefined = import.meta.env
    .VITE_OR_STEALTH_ALLOWED_ORIGINS as string | undefined,
): ReadonlySet<string> {
  const resolved = raw || STEALTH_DEFAULT_ORIGIN;
  return new Set(
    resolved
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

export function isAllowedOrigin(
  origin: string,
  allowlist: ReadonlySet<string>,
): boolean {
  return allowlist.has(origin);
}
