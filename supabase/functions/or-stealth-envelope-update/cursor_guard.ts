/**
 * cursor_guard.ts -- pure cursor-advance logic for or-stealth-envelope-update.
 *
 * Extracted as a standalone module so the forward-only guard can be unit-tested
 * independently of the Deno.serve / Supabase wiring. The production handler in
 * index.ts enforces the same contract atomically at the database level using a
 * conditional WHERE on the UPDATE, so this module is test scaffolding only.
 *
 * Invariant: the stored cursor never moves backwards.
 */

export interface CursorEvaluation {
  /** True when the UPDATE filter would fire (stored < incoming). */
  shouldUpdate: boolean;
  /** The effective cursor after the operation. */
  effectiveCursor: number;
}

/**
 * Evaluate whether an incoming cursor tip should advance the stored value.
 *
 * Mirrors the database-level condition used in the production UPDATE:
 *   WHERE last_block_scanned IS NULL OR last_block_scanned < incoming
 *
 * @param stored  Current stored cursor (null means never set, treated as -1).
 * @param incoming  Candidate new cursor value (non-negative integer).
 */
export function evaluateForwardOnly(
  stored: number | null,
  incoming: number,
): CursorEvaluation {
  const effective = stored ?? -1;
  if (incoming > effective) {
    return { shouldUpdate: true, effectiveCursor: incoming };
  }
  return { shouldUpdate: false, effectiveCursor: effective };
}
