/**
 * Classify a Supabase/PostgREST read into the three outcomes a naive
 * `if (!data) ...` check collapses into one: a row was found, no row
 * exists, or the read itself failed (a renamed column, an RLS refusal,
 * an expired token, a dropped connection).
 *
 * PostgREST returns `data: null` for both "no row" and "the read failed",
 * and the shape depends on the query builder used:
 *  - `.single()` errors on zero rows (PGRST116), so "no row" already
 *    carries an error there.
 *  - `.maybeSingle()` and a plain `.select()` return `data: null` (or an
 *    empty array) with `error: null` when nothing matches, and only set
 *    `error` for a genuine failure.
 *
 * `error` is the only field that tells the two apart. This function is
 * the one place that check happens, so it can be tested once instead of
 * re-derived, wrong, at every call site.
 *
 * See the co-admin gate effect in src/routes/app.tsx (DEV-0392): every
 * read there used to destructure `data` only, so a failed read presented
 * as an absent row and a workspace silently disappeared instead of the
 * failure being surfaced.
 */
export type ReadOutcome = "row" | "empty" | "error";

export function classifyRead(data: unknown, error: unknown): ReadOutcome {
  if (error) {
    const err = error as { code?: string; details?: string | null } | null;
    // .single() reports PGRST116 for both "0 rows" and ">1 rows"; only the
    // confirmed zero-row case is a legitimate empty result, not a failure.
    if (err?.code === "PGRST116" && /contain 0 rows/i.test(err.details ?? "")) {
      return "empty";
    }
    return "error";
  }
  if (data === null || data === undefined) return "empty";
  if (Array.isArray(data) && data.length === 0) return "empty";
  return "row";
}
