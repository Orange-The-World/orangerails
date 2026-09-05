/**
 * Parsing and diagnostics for the REQUIRE_WIDGET_TOKEN environment
 * variable that gates or-link-complete's widget_token check (audit
 * 2026-05-16 High #3, DEV-0189, DEV-0204).
 *
 * Split out from or-link-complete/index.ts so it can be unit tested
 * without importing that module, whose top level runs
 * guardAccountFingerprintKey() and Deno.serve() as import side effects.
 *
 * DEV-0204 PR 1 (this file): parsing and loud reporting only, no
 * behaviour change. The gate still defaults to permissive for both
 * "unset" and "unrecognised" values, exactly as it does today.
 *
 * DEV-0204 PR 2 (separate PR, held on DL-2061 and DEV-0202 reporting):
 * flips the default for "unset-or-unrecognised" from permissive to
 * refusing (401). That PR changes only what the caller does with the
 * state below, not this file.
 */

export type RequireWidgetTokenState = "true" | "false" | "unset-or-unrecognised";

/**
 * Classify the raw REQUIRE_WIDGET_TOKEN env value into exactly the
 * three states DEV-0204 calls for.
 *
 * Behaviour-preserving: classifyRequireWidgetToken(raw) === "true" iff
 * the original expression `(raw ?? "false").toLowerCase() === "true"`
 * was true. See widget-token-gate.test.ts for the explicit
 * cross-check against that expression.
 *
 * Deliberately exact-match, case-insensitive, on "true" and "false"
 * only. Anything else -- unset, empty string, "1", "yes", "True " with
 * a trailing space -- is "unset-or-unrecognised", the same permissive
 * bucket the code has always fallen into for those inputs. What
 * changes in DEV-0204 PR 1 is that this bucket now gets reported
 * loudly (see describeRequireWidgetTokenGap) instead of silently.
 */
export function classifyRequireWidgetToken(
  raw: string | undefined,
): RequireWidgetTokenState {
  if (raw === undefined) return "unset-or-unrecognised";
  const lowered = raw.toLowerCase();
  if (lowered === "true") return "true";
  if (lowered === "false") return "false";
  return "unset-or-unrecognised";
}

/**
 * Human-readable diagnostic for the "unset-or-unrecognised" state,
 * naming which sub-case it actually is: nobody set the variable, or
 * somebody set it to a value this parser does not honour. The raw
 * value is included so an unrecognised value shows up in the log and
 * in GlitchTip rather than only in whichever dashboard someone typed
 * it into -- that visibility is the whole point of DEV-0204 PR 1.
 *
 * Callers should not invoke this for "true" or "false"; those states
 * are the intentional, already-explicit configuration and do not need
 * a gap explained.
 */
export function describeRequireWidgetTokenGap(raw: string | undefined): string {
  if (raw === undefined) {
    return "REQUIRE_WIDGET_TOKEN is not set";
  }
  return (
    `REQUIRE_WIDGET_TOKEN is set to an unrecognised value ${JSON.stringify(raw)} ` +
    `(expected exactly "true" or "false")`
  );
}
