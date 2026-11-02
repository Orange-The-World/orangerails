/**
 * Tests for src/lib/audit.ts.
 *
 * WHY THIS FILE IS NEW. Nothing exercised logSecurityEvent's rejection
 * branch: it only ever produced a console.warn, so a caller had no way to
 * tell a written event from a silently dropped one, and DEV-0382 found that
 * the list-only co-admin clear reported plain success either way. These
 * cases pin the boolean contract logSecurityEvent now returns so that
 * contract cannot regress back to Promise<void> without a test failing.
 */

import { describe, it, expect, vi } from "vitest";
import { logSecurityEvent } from "../audit";

describe("logSecurityEvent", () => {
  it("resolves true when the insert succeeds", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const supabase = { from: () => ({ insert }) };

    const result = await logSecurityEvent(supabase, "user-1", "coadmin_revoked", {
      admin_user_id: "admin-1",
    });

    expect(result).toBe(true);
    expect(insert).toHaveBeenCalledWith({
      user_id: "user-1",
      event: "coadmin_revoked",
      metadata: { admin_user_id: "admin-1" },
    });
  });

  it("resolves false, and never throws, when Supabase returns a rejected insert", async () => {
    // Supabase reports an RLS rejection as an error OBJECT on the response,
    // not as a thrown exception. audit.ts's own comment says a bare catch
    // would miss this, so the fixture models that shape rather than a thrown
    // error.
    const insert = vi.fn().mockResolvedValue({
      error: { message: "permission denied", code: "42501" },
    });
    const supabase = { from: () => ({ insert }) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await logSecurityEvent(supabase, "user-1", "coadmin_list_entry_cleared", {
      admin_user_id: "admin-1",
      key_removed: false,
    });

    expect(result).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("resolves false, and never throws, when the client throws outright", async () => {
    const insert = vi.fn().mockRejectedValue(new Error("network drop"));
    const supabase = { from: () => ({ insert }) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await logSecurityEvent(supabase, "user-1", "coadmin_list_entry_cleared", {
      admin_user_id: "admin-1",
      key_removed: true,
    });

    expect(result).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
