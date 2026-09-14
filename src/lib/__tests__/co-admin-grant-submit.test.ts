/**
 * Tests for grantCoAdminAndRefresh, in src/lib/co-admin-grant-submit.ts
 * (OR-T1238).
 *
 * WHAT IS BEING PINNED. persistCoAdminGrant writes the workspace_admins list
 * row before the wrapped_data_keys row, so a grant that fails on the second
 * write (CoAdminGrantIncompleteError) leaves a real row the owner cannot see
 * until the on-screen list is re-read. grantCoAdminAndRefresh is the single
 * place that decides whether to re-read that list, and these cases pin the
 * three things that decision has to get right:
 *   1. A CoAdminGrantIncompleteError triggers a refresh, and the original
 *      error still reaches the caller unchanged.
 *   2. A grant that throws before the list write (nothing new to show) does
 *      NOT trigger a refresh.
 *   3. A refresh that itself throws never replaces the grant's own error.
 */

import { describe, it, expect, vi } from "vitest";
import { grantCoAdminAndRefresh } from "../co-admin-grant-submit";
import { CoAdminGrantIncompleteError } from "../co-admin";

/** Resolves to whatever the promise rejected with, so it can be inspected. */
function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected this to reject and it resolved");
    },
    (e: unknown) => e,
  );
}

describe("a grant that leaves the list write behind refreshes the list", () => {
  it("refreshes the list and still throws CoAdminGrantIncompleteError unchanged", async () => {
    const incomplete = new CoAdminGrantIncompleteError(
      "This co-admin was added to your list, but the key that gives them access was not stored.",
    );
    const refreshList = vi.fn().mockResolvedValue(undefined);

    const err = await rejection(
      grantCoAdminAndRefresh({
        grant: () => Promise.reject(incomplete),
        refreshList,
      }),
    );

    expect(err).toBe(incomplete);
    expect(refreshList).toHaveBeenCalledTimes(1);
  });

  it("does not swallow the grant's own error when the refresh itself fails", async () => {
    const incomplete = new CoAdminGrantIncompleteError("left behind");
    const refreshList = vi.fn().mockRejectedValue(new Error("list re-read failed"));

    const err = await rejection(
      grantCoAdminAndRefresh({
        grant: () => Promise.reject(incomplete),
        refreshList,
      }),
    );

    // The grant's own error is what the owner needs to see, not why the
    // re-read on top of it also failed.
    expect(err).toBe(incomplete);
    expect(refreshList).toHaveBeenCalledTimes(1);
  });
});

describe("a grant that fails before the list write never triggers a refresh", () => {
  it("propagates a plain error and does not call refreshList", async () => {
    const plainError = new Error("That vault password is not correct.");
    const refreshList = vi.fn().mockResolvedValue(undefined);

    const err = await rejection(
      grantCoAdminAndRefresh({
        grant: () => Promise.reject(plainError),
        refreshList,
      }),
    );

    expect(err).toBe(plainError);
    expect(refreshList).not.toHaveBeenCalled();
  });
});

describe("a successful grant", () => {
  it("resolves with the grant's result and does not touch the list itself", async () => {
    const refreshList = vi.fn().mockResolvedValue(undefined);

    const result = await grantCoAdminAndRefresh({
      grant: () => Promise.resolve({ workspaceKeyId: "workspace-key-1" }),
      refreshList,
    });

    expect(result).toEqual({ workspaceKeyId: "workspace-key-1" });
    // The success-path refresh is the caller's job (it always ran a list
    // refresh before this helper existed); this helper only adds a refresh
    // to the failure path, so it must not double up on success.
    expect(refreshList).not.toHaveBeenCalled();
  });
});
