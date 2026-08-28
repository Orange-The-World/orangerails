/**
 * Tests for the revoke path in src/lib/co-admin.ts.
 *
 * WHY THIS FILE IS NEW. co-admin.test.ts covers grant, consume and a
 * store-layer revocation that never touches a database surface. Nothing
 * exercised revokeCoAdmin, which is the function the product actually calls
 * when an owner revokes emergency access.
 *
 * WHAT IS BEING PINNED, and why a weaker test would be worthless. The old code
 * issued both deletes and threw only on an error. A delete that matches no row
 * returns no error, so a test that asserted "a delete was issued against
 * wrapped_data_keys" would have passed against code that removed nothing and
 * reported success. Every case here therefore asserts on the removed-row count
 * or on the order, never on the mere existence of a call.
 *
 * WHAT THE FIXTURES MODEL. Deletes return the rows they removed, which is what
 * .select() after a delete gives you. The zero-row fixtures are not
 * hypothetical: measured on the dev project as an authenticated owner, the
 * wrapped_data_keys delete removed 0 rows without an owner SELECT policy and 1
 * with it.
 */

import { describe, it, expect } from "vitest";
import { revokeCoAdmin } from "../co-admin";

interface RecordedDelete {
  table: string;
  filters: Array<{ column: string; value: string }>;
  columns?: string;
}

interface FakeOptions {
  /** rows each delete removes, by table */
  removed?: Record<string, Record<string, unknown>[]>;
  /** an error from a delete on a table, instead of rows */
  errors?: Record<string, unknown>;
}

function makeFakeClient(options: FakeOptions = {}) {
  const deletes: RecordedDelete[] = [];

  function builderFor(call: RecordedDelete) {
    const builder = {
      eq(column: string, value: string) {
        call.filters.push({ column, value });
        return builder;
      },
      select(columns: string) {
        call.columns = columns;
        const error = options.errors?.[call.table] ?? null;
        return Promise.resolve({
          data: error ? null : (options.removed?.[call.table] ?? []),
          error,
        });
      },
      then() {
        throw new Error("this test client only supports a delete that asks for its rows back");
      },
    };
    return builder;
  }

  const client = {
    from(table: string) {
      return {
        delete() {
          const call: RecordedDelete = { table, filters: [] };
          deletes.push(call);
          return builderFor(call);
        },
      };
    },
  };

  return {
    client: client as unknown as Parameters<typeof revokeCoAdmin>[0]["supabase"],
    deletes,
  };
}

const BOTH_REMOVED: FakeOptions = {
  removed: {
    wrapped_data_keys: [{ recipient_user_id: "admin-1" }],
    workspace_admins: [{ admin_user_id: "admin-1" }],
  },
};

function revoke(supabase: Parameters<typeof revokeCoAdmin>[0]["supabase"]) {
  return revokeCoAdmin({
    ownerWorkspaceKeyId: "workspace-key-1",
    adminUserId: "admin-1",
    ownerUserId: "owner-1",
    supabase,
  });
}

describe("revoking a co-admin proves both deletes", () => {
  it("removes the wrapped key and the admin list row, filtered to that one admin", async () => {
    const { client, deletes } = makeFakeClient(BOTH_REMOVED);

    await expect(revoke(client)).resolves.toBeUndefined();

    expect(deletes).toHaveLength(2);

    const wdk = deletes[0];
    expect(wdk.table).toBe("wrapped_data_keys");
    expect(wdk.filters).toEqual([
      { column: "data_key_id", value: "workspace-key-1" },
      { column: "recipient_user_id", value: "admin-1" },
    ]);
    // Asking for the removed rows back is the entire difference between a
    // revocation and a request that did not fail.
    expect(wdk.columns).toBe("recipient_user_id");

    const admins = deletes[1];
    expect(admins.table).toBe("workspace_admins");
    expect(admins.filters).toEqual([
      { column: "owner_user_id", value: "owner-1" },
      { column: "admin_user_id", value: "admin-1" },
    ]);
    expect(admins.columns).toBe("admin_user_id");
  });

  it("removes the key row BEFORE the admin list row", async () => {
    const { client, deletes } = makeFakeClient(BOTH_REMOVED);

    await revoke(client);

    // The key row is what grants access; the list row is the record of who
    // holds it. Stopping between the two must leave the evidence and not the
    // access, so this order is the safe one and the old order was not.
    expect(deletes.map((d) => d.table)).toEqual(["wrapped_data_keys", "workspace_admins"]);
  });

  it("fails the revocation when the key delete removes nothing, and keeps the admin row", async () => {
    const { client, deletes } = makeFakeClient({
      removed: { wrapped_data_keys: [], workspace_admins: [{ admin_user_id: "admin-1" }] },
    });

    // This is the case the old code called success. Nothing was removed and
    // nothing complained, so the recipient still holds a validly signed grant
    // and can still open the owner's data.
    await expect(revoke(client)).rejects.toThrow(/still have access/);

    // The admin list row survives on purpose: it is the only record of who
    // still holds access, and deleting it here would hide the problem while
    // leaving the access in place.
    expect(deletes.map((d) => d.table)).toEqual(["wrapped_data_keys"]);
  });

  it("does not touch the admin list when the key delete errors", async () => {
    const { client, deletes } = makeFakeClient({
      errors: { wrapped_data_keys: { message: "permission denied" } },
    });

    await expect(revoke(client)).rejects.toThrow(/wrapped_data_keys/);
    expect(deletes.map((d) => d.table)).toEqual(["wrapped_data_keys"]);
  });

  it("says access WAS revoked when only the list delete removes nothing", async () => {
    const { client } = makeFakeClient({
      removed: { wrapped_data_keys: [{ recipient_user_id: "admin-1" }], workspace_admins: [] },
    });

    // Half done, and which half decides what the owner should do. Access is
    // genuinely gone here; an owner told only "revocation failed" would
    // reasonably believe the opposite.
    await expect(revoke(client)).rejects.toThrow(/Access was revoked/);
  });

  it("says access WAS revoked when the list delete errors", async () => {
    const { client } = makeFakeClient({
      removed: { wrapped_data_keys: [{ recipient_user_id: "admin-1" }] },
      errors: { workspace_admins: { message: "permission denied" } },
    });

    await expect(revoke(client)).rejects.toThrow(/Access was revoked/);
  });
});
