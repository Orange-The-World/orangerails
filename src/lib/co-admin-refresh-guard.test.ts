import { describe, it, expect } from "vitest";
import { shouldApplyCoAdminRefresh } from "./co-admin-refresh-guard";

describe("shouldApplyCoAdminRefresh", () => {
  it("allows applying the refresh when every read succeeded", () => {
    expect(shouldApplyCoAdminRefresh([{ error: null }, { error: null }])).toBe(true);
  });

  it("allows applying the refresh when there was nothing to check", () => {
    expect(shouldApplyCoAdminRefresh([])).toBe(true);
  });

  it("refuses to apply the refresh when one read was rejected", () => {
    expect(
      shouldApplyCoAdminRefresh([{ error: null }, { error: { message: "permission denied" } }]),
    ).toBe(false);
  });

  it("refuses to apply the refresh when every read was rejected", () => {
    expect(
      shouldApplyCoAdminRefresh([
        { error: { message: "permission denied" } },
        { error: { message: "permission denied" } },
      ]),
    ).toBe(false);
  });

  it("does not confuse a rejected read with a legitimately empty one", () => {
    // A legitimate empty result never carries an error at all, so it must
    // not trip the guard. Only a populated `error` field should.
    expect(shouldApplyCoAdminRefresh([{ error: null }])).toBe(true);
  });
});
