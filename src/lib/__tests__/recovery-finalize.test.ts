/**
 * Tests for src/lib/recovery-finalize.ts.
 *
 * WHAT IS BEING PINNED. At the end of a recovery the new recovery code exists
 * in exactly one place, the variable about to be handed to the screen, and the
 * vault it opens has already been rotated in the database. So the property
 * under test is an ORDER: the code is shown first, and everything that can go
 * wrong happens afterwards.
 *
 * An order cannot be pinned by asserting outcomes, because every assertion
 * about the end state passes just as happily against the wrong order. So these
 * tests record the sequence of calls and assert on the sequence itself.
 */

import { describe, it, expect } from "vitest";
import { finalizeRecovery } from "../recovery-finalize";
import type { CoAdminInvalidation } from "../co-admin-recovery";

interface Harness {
  calls: string[];
  notices: (string | null)[];
  run: (overrides?: Partial<Parameters<typeof finalizeRecovery>[0]>) => Promise<void>;
}

function harness(result: CoAdminInvalidation = { status: "none" }): Harness {
  const calls: string[] = [];
  const notices: (string | null)[] = [];

  return {
    calls,
    notices,
    run: (overrides = {}) =>
      finalizeRecovery({
        showNewRecoveryCode: () => calls.push("show-code"),
        logRecoveryEvent: () => calls.push("log-event"),
        invalidateCoAdminGrants: async () => {
          calls.push("cleanup");
          return result;
        },
        showCoAdminNotice: (message) => {
          calls.push("notice");
          notices.push(message);
        },
        describeError: (error) => (error as Error).message,
        ...overrides,
      }),
  };
}

describe("finishing a recovery", () => {
  it("shows the new recovery code before anything else is attempted", async () => {
    const h = harness({ status: "invalidated", grantsInvalidated: 1, people: ["ana@example.com"] });

    await h.run();

    // The code is the only copy in existence and the vault is already rotated,
    // so every statement standing in front of the screen is a way to lose it.
    expect(h.calls).toEqual(["show-code", "log-event", "cleanup", "notice"]);
    expect(h.notices[0]).toContain("ana@example.com");
  });

  it("still shows the code when the co-admin cleanup throws", async () => {
    const h = harness();

    await h.run({
      invalidateCoAdminGrants: async () => {
        h.calls.push("cleanup");
        throw new Error("network down");
      },
    });

    expect(h.calls[0]).toBe("show-code");
    // The recovery succeeded. A cleanup failure is something for the owner to
    // act on, not a reason to take their recovery code away.
    expect(h.notices[0]).toContain("network down");
    expect(h.notices[0]).toContain("Settings");
  });

  it("still shows the code, and still cleans up, when the audit write throws", async () => {
    const h = harness();

    await h.run({
      logRecoveryEvent: () => {
        h.calls.push("log-event");
        throw new Error("audit unavailable");
      },
    });

    expect(h.calls).toEqual(["show-code", "log-event", "cleanup", "notice"]);
  });

  it("does not throw out of the cleanup, so the caller never sees a failed recovery", async () => {
    const h = harness();

    await expect(
      h.run({
        invalidateCoAdminGrants: async () => {
          throw new Error("boom");
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("says nothing about emergency access when there was none to invalidate", async () => {
    const h = harness({ status: "none" });

    await h.run();

    // A null notice renders nothing. An owner with no co-admins should not be
    // handed a sentence about co-admins.
    expect(h.notices).toEqual([null]);
  });
});
