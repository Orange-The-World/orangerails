/**
 * Tests for src/lib/post-recovery.ts.
 *
 * WHAT IS BEING PINNED, and why it is an order rather than an outcome. When
 * this sequence starts, the new recovery code exists in exactly one place: a
 * local variable in the page. Its ciphertext is already stored and the
 * plaintext is never displayed again. So a statement inserted above
 * showNewRecoveryCode is a way to lose a user's vault for good, and no other
 * test in this repo would notice. These tests notice.
 *
 * The second half of the guarantee is that nothing AFTER the code screen can
 * take it away. Each later step is asserted to fail harmlessly, because by
 * then the recovery has already succeeded and turning after-care into an error
 * would both mislead the user and replace the one screen holding their code.
 */

import { describe, it, expect, vi } from "vitest";
import { runPostRecovery, type PostRecoverySteps } from "../post-recovery";
import type { CoAdminInvalidation } from "../co-admin-recovery";

const INVALIDATED: CoAdminInvalidation = {
  status: "invalidated",
  grantsInvalidated: 2,
  people: ["ada@example.com", "grace@example.com"],
  peopleAreComplete: true,
};

/**
 * Steps that append their own name to a shared list, so the assertions can be
 * about sequence and not only about whether something was called.
 */
function makeSteps(overrides: Partial<PostRecoverySteps> = {}) {
  const order: string[] = [];
  const notices: CoAdminInvalidation[] = [];

  const steps: PostRecoverySteps = {
    showNewRecoveryCode: vi.fn(() => {
      order.push("showNewRecoveryCode");
    }),
    invalidateCoAdminGrants: vi.fn(async () => {
      order.push("invalidateCoAdminGrants");
      return INVALIDATED;
    }),
    showCoAdminNotice: vi.fn((result: CoAdminInvalidation) => {
      order.push("showCoAdminNotice");
      notices.push(result);
    }),
    logRecovery: vi.fn(() => {
      order.push("logRecovery");
    }),
    formatError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
    ...overrides,
  };

  return { steps, order, notices };
}

describe("what runs after a recovery has landed, and in which order", () => {
  it("shows the new recovery code FIRST, before any of the after-care", async () => {
    const { steps, order } = makeSteps();

    await runPostRecovery(steps);

    // This is the whole point of the module. At the moment the first entry
    // runs, the code in hand is the only copy that will ever exist.
    expect(order[0]).toBe("showNewRecoveryCode");
    expect(order).toEqual([
      "showNewRecoveryCode",
      "invalidateCoAdminGrants",
      "showCoAdminNotice",
      "logRecovery",
    ]);
  });

  it("passes the cleanup result through to the notice unchanged", async () => {
    const { steps, notices } = makeSteps();

    await runPostRecovery(steps);

    // The names matter: the owner is being asked to re-grant to these people
    // and the cleanup has just deleted the only record of who they were.
    expect(notices).toEqual([INVALIDATED]);
  });

  it("still shows the code when the co-admin cleanup throws, and reports it as a notice", async () => {
    const { steps, order, notices } = makeSteps({
      invalidateCoAdminGrants: vi.fn(async () => {
        throw new Error("cleanup exploded");
      }),
    });

    await expect(runPostRecovery(steps)).resolves.toBeUndefined();

    expect(order[0]).toBe("showNewRecoveryCode");
    // A cleanup problem is something the owner can act on. A thrown error here
    // would be reported as a failed recovery, which would be false: the vault
    // is recovered and the meta write was proven before this ever ran.
    expect(notices).toEqual([{ status: "failed", reason: "cleanup exploded" }]);
  });

  it("still shows the code when the notice itself throws", async () => {
    const { steps, order } = makeSteps({
      showCoAdminNotice: vi.fn(() => {
        throw new Error("render exploded");
      }),
    });

    await expect(runPostRecovery(steps)).resolves.toBeUndefined();

    expect(order[0]).toBe("showNewRecoveryCode");
    expect(steps.logRecovery).toHaveBeenCalled();
  });

  it("still shows the code when the audit log throws", async () => {
    const { steps, order } = makeSteps({
      logRecovery: vi.fn(() => {
        throw new Error("log exploded");
      }),
    });

    await expect(runPostRecovery(steps)).resolves.toBeUndefined();

    // An unrecorded recovery is a gap in an audit trail. A lost recovery code
    // is a lost vault. They are not the same size of problem.
    expect(order[0]).toBe("showNewRecoveryCode");
    expect(steps.showCoAdminNotice).toHaveBeenCalled();
  });
});
