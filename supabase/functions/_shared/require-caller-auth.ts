/**
 * requireCallerAuth -- the one shared, named auth helper every or-* function
 * that authenticates its caller is meant to call (OR-T1041).
 *
 * scripts/check-auth-marker.mjs enforces this MECHANICALLY, by searching for
 * the call, not by judging whether the code is right: a function whose
 * supabase/functions/public-auth.json entry is anything other than "none"
 * must contain a call to `requireCallerAuth(`, and a function declared
 * "none" must contain no such call. That is a marker, not a proof that the
 * auth logic is correct. See the script's header for why a code-analysis
 * approach was tried on this repo first and rejected: it produced false
 * positives that read as coverage, which is worse than no check at all.
 *
 * WHY ONE FUNCTION, when the declared modes verify completely different
 * things (an HMAC signature, a platform API key hash, an ORBI key hash, a
 * static internal worker token, or platform-key-or-widget-token): the CI
 * gate only needs one name to search for. requireCallerAuth does not
 * reimplement any of those checks. Each mode's real verification is passed
 * in as `verify`, so this helper adds a single call site and a uniform
 * failure shape, not a new auth implementation to trust.
 *
 * NOT WIRED UP YET. Landing this helper does not change any existing
 * function's behaviour. Moving a function onto this call is its own change,
 * done one function at a time and tracked in OR-T1039 (or-institutions-
 * catalog) and OR-T1040 (every other function currently listed in
 * KNOWN_EXCEPTIONS in scripts/check-auth-marker.mjs). Until a function is
 * migrated it stays a dated, named exception there, never a silent one.
 */

export type CallerAuthMode =
  | 'hmac'
  | 'platform-api-key'
  | 'platform-api-key-or-widget-token'
  | 'orbi-api-key'
  | 'internal-worker-token';

export interface CallerAuthResult {
  ok: boolean;
  /** Present when ok is false. */
  status?: number;
  /** Present when ok is false. Safe to return to the caller: never leaks why, only that it failed. */
  message?: string;
}

/**
 * Run the mode-specific `verify` check and return a uniform result.
 *
 * @param mode    The mode this call site is asserting, matching the value
 *                this function is declared under in public-auth.json.
 * @param verify  The real check for that mode (HMAC signature verification,
 *                a key-hash lookup, a timing-safe token compare, ...). Kept
 *                as an injected function rather than switched on internally
 *                so this helper never has to be trusted with, or kept in
 *                sync with, every mode's actual secret-handling code.
 */
export async function requireCallerAuth(
  mode: CallerAuthMode,
  verify: () => Promise<boolean> | boolean,
): Promise<CallerAuthResult> {
  let ok: boolean;
  try {
    ok = await verify();
  } catch (err) {
    console.error(`[requireCallerAuth] ${mode} verify threw:`, err instanceof Error ? err.message : err);
    ok = false;
  }
  if (!ok) {
    return { ok: false, status: 401, message: `Caller failed ${mode} authentication` };
  }
  return { ok: true };
}
