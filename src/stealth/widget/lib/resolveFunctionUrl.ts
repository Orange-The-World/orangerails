/**
 * Resolve the absolute URL for a Supabase edge function by name.
 *
 * Resolution order (first match wins):
 *   1. proxyBaseUrl (from OR_STEALTH_INIT.proxy_base_url) - routes through
 *      the consuming app's server-side proxy. The proxy attaches the platform
 *      API key without exposing it to the browser.
 *   2. VITE_OR_FUNCTIONS_BASE_URL build-time env - direct Supabase functions
 *      host (requires the consumer to pass access_token in INIT for Bearer auth).
 *   3. VITE_SUPABASE_URL build-time env - Supabase project root; appends
 *      /functions/v1/<name>.
 *
 * NEVER returns a relative path. A relative URL like /functions/v1/<name>
 * resolves against window.location.origin (the Cloudflare Pages host), and
 * Pages answers 405 to any POST request. Throw instead so the misconfiguration
 * is surfaced immediately rather than buried in a 405 response body.
 *
 * The optional _env parameter exists for unit testing: pass a plain object
 * to avoid vi.stubEnv or global state in tests. Production callers omit it
 * and the function reads import.meta.env directly.
 */
export function resolveFunctionUrl(
  name: string,
  proxyBaseUrl?: string,
  _env?: { VITE_OR_FUNCTIONS_BASE_URL?: string; VITE_SUPABASE_URL?: string },
): string {
  if (proxyBaseUrl) {
    return `${proxyBaseUrl.replace(/\/$/, "")}/${name}`;
  }
  const env =
    _env ??
    (import.meta.env as {
      VITE_OR_FUNCTIONS_BASE_URL?: string;
      VITE_SUPABASE_URL?: string;
    });
  const fnBase = (env.VITE_OR_FUNCTIONS_BASE_URL ?? "").replace(/\/$/, "");
  if (fnBase) return `${fnBase}/${name}`;
  const supabaseUrl = (env.VITE_SUPABASE_URL ?? "").replace(/\/$/, "");
  if (supabaseUrl) return `${supabaseUrl}/functions/v1/${name}`;
  throw new Error(
    `resolveFunctionUrl: cannot build POST target for '${name}'. ` +
      `Set VITE_OR_FUNCTIONS_BASE_URL or VITE_SUPABASE_URL in the build environment.`,
  );
}
