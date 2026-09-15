/**
 * Tests for describeCoAdminWorkspacesLoadFailure (OR-T0834 step 7).
 *
 * This pins the exact composition src/routes/app.tsx's co-admin gate effect
 * relies on for its list_coadmin_workspaces read: a PostgREST error must
 * produce a user-facing message, and a genuinely empty result (administering
 * nothing) must stay silent. Before DEV-0401 the two were conflated -- a
 * failed read was indistinguishable from an empty one -- and that is the
 * defect class this guards against.
 *
 * What this does NOT prove: that src/routes/app.tsx actually calls this
 * function and actually calls setErr with its message. No test harness
 * reaches that screen today (see OR-E0018); this is the same limitation
 * DEV-0401's own co-admin-refresh-guard.ts extraction already carries, by
 * the same reasoning, stated in its own docstring.
 */
import { describe, it, expect } from "vitest";
import { describeCoAdminWorkspacesLoadFailure } from "../co-admin-workspaces-load-error";

describe("describeCoAdminWorkspacesLoadFailure", () => {
  it("stays silent when the caller administers nothing (empty, no error)", () => {
    expect(describeCoAdminWorkspacesLoadFailure([], null)).toEqual({ failed: false });
    expect(describeCoAdminWorkspacesLoadFailure(null, null)).toEqual({ failed: false });
  });

  it("stays silent when rows are present", () => {
    const result = describeCoAdminWorkspacesLoadFailure(
      [{ owner_user_id: "owner-1", workspace_key_id: "key-1", sig_public_key: "pub" }],
      null,
    );
    expect(result).toEqual({ failed: false });
  });

  it("surfaces a message on a genuine PostgREST failure, the old destructure-only-data shape reported this as empty", () => {
    const pgError = {
      code: "42501",
      message: "permission denied for function list_coadmin_workspaces",
    };
    const result = describeCoAdminWorkspacesLoadFailure(null, pgError);
    expect(result.failed).toBe(true);
    if (result.failed) {
      expect(result.message).toContain("Could not load your co-admin workspaces");
      expect(result.message).toContain("permission denied for function list_coadmin_workspaces");
    }
  });

  it("surfaces a message even when stale data is present alongside an error", () => {
    // Mirrors classifyRead's own "error alongside a non-empty array is still
    // error, not row" case: a caller must not read stale data as success.
    const result = describeCoAdminWorkspacesLoadFailure([{ owner_user_id: "owner-1" }], {
      code: "PGRST301",
      message: "JWT expired",
    });
    expect(result.failed).toBe(true);
    if (result.failed) {
      expect(result.message).toContain("JWT expired");
    }
  });

  it("carries formatError's rendering of the error, not a generic message", () => {
    const result = describeCoAdminWorkspacesLoadFailure(null, "a bare string error");
    expect(result.failed).toBe(true);
    if (result.failed) {
      expect(result.message).toBe("Could not load your co-admin workspaces: a bare string error");
    }
  });
});
