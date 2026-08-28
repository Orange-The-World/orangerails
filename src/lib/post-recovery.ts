/**
 * What happens after a vault recovery has provably landed, and in which order.
 *
 * THE ORDER IS THE POINT. At the moment the rotated meta write is proven, the
 * new recovery code exists in exactly one place: a local variable. Its
 * ciphertext is already in the database and nothing can ever display the
 * plaintext again, so every statement standing between that proof and the
 * screen showing the code is a way to lose it permanently.
 *
 * So the code is shown FIRST, before anything else runs. Nothing on this path
 * throws today, which is why this was never a live defect. Ordering it this
 * way removes the whole class instead of auditing each member of it, and it
 * keeps removing it as statements are added later by someone who does not know
 * this paragraph exists.
 *
 * EVERYTHING AFTER IS AFTER-CARE, AND IT CANNOT FAIL THE RECOVERY. The
 * recovery has already succeeded. Raising a cleanup problem as an error would
 * tell the user something false about their vault, and by this point it could
 * also replace the screen holding the only copy of their code. So every later
 * step is swallowed and reported as a notice instead.
 *
 * This lives in a module rather than inline in src/routes/recover.tsx because
 * an ordering guarantee asserted by a comment is an ordering guarantee nothing
 * checks. This one has a test.
 */

import type { CoAdminInvalidation } from "./co-admin-recovery";

export interface PostRecoverySteps {
  /**
   * Put the new recovery code on screen. Runs first and unconditionally: it is
   * the only chance the user gets to see it.
   */
  showNewRecoveryCode: () => void;
  /**
   * Remove the co-admin grants the rotation just made undecryptable. Contracted
   * not to throw, and wrapped here anyway, because an unexpected throw must
   * still become something the owner can act on.
   */
  invalidateCoAdminGrants: () => Promise<CoAdminInvalidation>;
  /** Show the owner what happened to emergency access, or nothing. */
  showCoAdminNotice: (result: CoAdminInvalidation) => void;
  /** Record the recovery. Fire and forget; a failed log is not a failed recovery. */
  logRecovery: () => void;
  /** Turn a thrown value into the sentence shown to the owner. */
  formatError: (err: unknown) => string;
}

/**
 * Run the after-recovery sequence. Never throws, never rejects: by the time it
 * is called the vault is already recovered.
 */
export async function runPostRecovery(steps: PostRecoverySteps): Promise<void> {
  // FIRST. See the note at the top of this file: nothing goes above this line.
  steps.showNewRecoveryCode();

  let result: CoAdminInvalidation;
  try {
    result = await steps.invalidateCoAdminGrants();
  } catch (err) {
    result = { status: "failed", reason: steps.formatError(err) };
  }

  try {
    steps.showCoAdminNotice(result);
  } catch {
    // A failure to render a notice must not take down the code screen.
  }

  try {
    steps.logRecovery();
  } catch {
    // An unrecorded recovery is a gap in an audit trail, not a lost vault.
  }
}
