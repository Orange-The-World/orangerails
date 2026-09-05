/**
 * Tests for grantCoAdminWithRefresh, the branch GrantCoAdminDialog's onSubmit
 * (src/routes/app.tsx) delegates to.
 *
 * WHAT IS BEING PINNED, per OR-T1238's acceptance:
 *   1. A grant that fails with CoAdminGrantIncompleteError (the key write
 *      failed after the list write landed) triggers a refresh, and the
 *      caller still receives CoAdminGrantIncompleteError, unchanged.
 *   2. A grant that throws before the list write (any other error) triggers
 *      no refresh at all, because nothing new was written to show.
 *   3. A refresh that itself fails does not replace or swallow the grant
 *      error; the grant failure is what the caller has to see.
 *
 * A weaker test would assert only "refreshList was called" without also
 * asserting it was NOT called on the other error path, which would pass a
 * version that refreshes unconditionally on every throw. Both directions are
 * asserted below for exactly that reason.
 */

import { describe, it, expect, vi } from "vitest";
import { grantCoAdminWithRefresh, CoAdminGrantIncompleteError } from "../co-admin";

function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected this to reject and it resolved");
    },
    (e: unknown) => e,
  );
}

describe("grantCoAdminWithRefresh: the key write failed, the list row landed", () => {
  it("refreshes the list and still reports CoAdminGrantIncompleteError to the caller", async () => {
    const refreshList = vi.fn().mockResolvedValue(undefined);
    const grantErr = new CoAdminGrantIncompleteError(
      "This co-admin was added to your list, but the key that gives them access was not stored.",
    );

    const err = await rejection(
      grantCoAdminWithRefresh({
        grant: () => Promise.reject(grantErr),
        refreshList,
      }),
    );

    expect(refreshList).toHaveBeenCalledTimes(1);
    // The exact same error instance, not a rewrapped or replaced one, so the
    // dialog's error UI shows what actually happened.
    expect(err).toBe(grantErr);
  });

  it("does not let a failing refresh replace or swallow the grant error", async () => {
    const onRefreshError = vi.fn();
    const grantErr = new CoAdminGrantIncompleteError("key write failed");

    const err = await rejection(
      grantCoAdminWithRefresh({
        grant: () => Promise.reject(grantErr),
        refreshList: () => Promise.reject(new Error("network error during refresh")),
        onRefreshError,
      }),
    );

    // The grant error is still what reaches the caller...
    expect(err).toBe(grantErr);
    // ...and the refresh failure was observed, not silently dropped.
    expect(onRefreshError).toHaveBeenCalledTimes(1);
    expect((onRefreshError.mock.calls[0][0] as Error).message).toContain("network error");
  });
});

describe("grantCoAdminWithRefresh: the grant failed before any row was written", () => {
  it("does not trigger a refresh for a plain Error (e.g. a bad password or an allocator refusal)", async () => {
    const refreshList = vi.fn().mockResolvedValue(undefined);
    const plainErr = new Error("Failed to allocate workspace_key_id: permission denied");

    const err = await rejection(
      grantCoAdminWithRefresh({
        grant: () => Promise.reject(plainErr),
        refreshList,
      }),
    );

    expect(refreshList).not.toHaveBeenCalled();
    expect(err).toBe(plainErr);
  });
});

describe("grantCoAdminWithRefresh: the happy path", () => {
  it("resolves with the grant's result and never calls refreshList itself", async () => {
    const refreshList = vi.fn().mockResolvedValue(undefined);

    const result = await grantCoAdminWithRefresh({
      grant: () => Promise.resolve({ workspaceKeyId: "workspace-key-1" }),
      refreshList,
    });

    expect(result).toEqual({ workspaceKeyId: "workspace-key-1" });
    // The success-path refresh is the caller's own responsibility (it always
    // needs one, not just conditionally), so this helper deliberately stays
    // out of that call.
    expect(refreshList).not.toHaveBeenCalled();
  });
});
