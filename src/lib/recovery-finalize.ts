/**
 * The last few steps of a vault recovery, in the order they have to happen.
 *
 * WHY THIS IS A MODULE AND NOT FOUR LINES IN THE PAGE. The order below is a
 * safety property, and a safety property that lives only in the sequence of
 * statements inside a component is a property nothing checks. This repo has no
 * component test setup, so anything left in recover.tsx is unreachable by the
 * suite. vault-persist.ts and co-admin-recovery.ts were pulled out of that same
 * page for the same reason.
 *
 * THE ORDER, and what each position is protecting.
 *
 * 1. SHOW THE NEW RECOVERY CODE. By the time we get here the rotated vault meta
 *    write is proven, so the code the user is holding is the only thing that
 *    can ever open this vault if they forget the password, and it exists in
 *    exactly one place: this variable. It has already been written to the
 *    database in its encrypted form and it is not derivable from anything we
 *    still hold. So it goes on the screen before anything else is attempted.
 *    Anything that runs first is a way to lose it: not because those steps
 *    throw today, but because "does not throw today" is a property of every
 *    line someone adds later, and nobody checks it.
 *
 * 2. RECORD THAT A RECOVERY HAPPENED. Fire and forget, and deliberately not
 *    awaited: an audit write that is slow or down must not hold up the one
 *    screen the user has to read.
 *
 * 3. CLEAN UP THE CO-ADMIN GRANTS AND SAY WHAT HAPPENED. This is the step that
 *    talks to the database and can take a while, and it is the one whose result
 *    is a message rather than a state the user depends on. It runs last, and it
 *    updates the screen that is already in front of them.
 *
 * NOTHING HERE THROWS. The recovery has already succeeded. Reporting a cleanup
 * failure as a failed recovery would tell the user something false about their
 * vault, and doing it after we have shown them their new code would be worse
 * still, because the page would swap an error in for the code they were told to
 * save.
 */

import { coAdminInvalidationMessage, type CoAdminInvalidation } from "./co-admin-recovery";

export interface FinalizeRecoveryArgs {
  /**
   * Put the new recovery code on the screen. Runs first, always, and must not
   * throw: it is a state setter.
   */
  showNewRecoveryCode: () => void;
  /** Write the audit record. Fire and forget. */
  logRecoveryEvent: () => void;
  /**
   * Remove the co-admin grants this rotation just killed. Contractually does
   * not throw, but is called as though it might.
   */
  invalidateCoAdminGrants: () => Promise<CoAdminInvalidation>;
  /** Show the owner what happened to emergency access, or nothing at all. */
  showCoAdminNotice: (message: string | null) => void;
  /** Turn an unexpected throw into a sentence. */
  describeError: (error: unknown) => string;
}

export async function finalizeRecovery(args: FinalizeRecoveryArgs): Promise<void> {
  const {
    showNewRecoveryCode,
    logRecoveryEvent,
    invalidateCoAdminGrants,
    showCoAdminNotice,
    describeError,
  } = args;

  // 1. The code, before anything that could go wrong.
  showNewRecoveryCode();

  // 2. The audit record. A failing audit write is not a failing recovery, and
  //    it certainly is not a reason to take the code back off the screen.
  try {
    logRecoveryEvent();
  } catch {
    // Deliberately swallowed. See above.
  }

  // 3. The co-admin cleanup, and the sentence that goes with it.
  let result: CoAdminInvalidation;
  try {
    result = await invalidateCoAdminGrants();
  } catch (cleanupErr) {
    result = { status: "failed", reason: describeError(cleanupErr), people: [] };
  }
  showCoAdminNotice(coAdminInvalidationMessage(result));
}
