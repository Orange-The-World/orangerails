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
 * reported success. Every case here therefore asserts on the removed-row count,
 * on the order, or on what the owner is told, never on the mere existence of a
 * call.
 *
 * AND THE SECOND ATTEMPT. The first version of this file passed against code
 * that dead ended the owner: its own remediation text sent them back into
 * revokeCoAdmin with the key already gone, which took the zero-row branch and
 * answered that they still had access. No test followed the owner through the
 * instruction the code printed, so nothing caught it. The cases below now do,
 * because that second attempt is where a retry, a double click and the recovery
 * cleanup all land.
 *
 * WHAT THE FIXTURES MODEL. Deletes return the rows they removed, which is what
 * .select() after a delete gives you. The zero-row fixtures are not
 * hypothetical: measured on the dev project as an authenticated owner, the
 * wrapped_data_keys delete removed 0 rows without an owner SELECT policy and 1
 * with it. The confirming read is modelled separately from the delete because
 * the whole point is that the two can disagree.
 */

import { describe, it, expect } from "vitest";
import {
  revokeCoAdmin,
  clearCoAdminListEntry,
  CoAdminRevocationIncompleteError,
} from "../co-admin";

interface RecordedCall {
  table: string;
  op: "delete" | "select";
  filters: Array<{ column: string; value: string }>;
  columns?: string;
  limit?: number;
}

interface FakeOptions {
  /** rows each delete removes, by table */
  removed?: Record<string, Record<string, unknown>[]>;
  /** an error from a delete on a table, instead of rows */
  errors?: Record<string, unknown>;
  /** rows a confirming read finds, by table */
  present?: Record<string, Record<string, unknown>[]>;
  /** an error from a confirming read on a table, instead of rows */
  readErrors?: Record<string, unknown>;
}

function makeFakeClient(options: FakeOptions = {}) {
  const calls: RecordedCall[] = [];

  function deleteBuilder(call: RecordedCall) {
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

  function selectBuilder(call: RecordedCall) {
    const builder = {
      eq(column: string, value: string) {
        call.filters.push({ column, value });
        return builder;
      },
      limit(count: number) {
        call.limit = count;
        const error = options.readErrors?.[call.table] ?? null;
        return Promise.resolve({
          data: error ? null : (options.present?.[call.table] ?? []),
          error,
        });
      },
      single() {
        throw new Error("these tests do not use single()");
      },
      maybeSingle() {
        throw new Error("these tests do not use maybeSingle()");
      },
    };
    return builder;
  }

  const client = {
    from(table: string) {
      return {
        delete() {
          const call: RecordedCall = { table, op: "delete", filters: [] };
          calls.push(call);
          return deleteBuilder(call);
        },
        select(columns: string) {
          const call: RecordedCall = { table, op: "select", filters: [], columns };
          calls.push(call);
          return selectBuilder(call);
        },
      };
    },
  };

  return {
    client: client as unknown as Parameters<typeof revokeCoAdmin>[0]["supabase"],
    calls,
  };
}

/** The tables that were actually deleted from, in order. */
function deletedTables(calls: RecordedCall[]): string[] {
  return calls.filter((c) => c.op === "delete").map((c) => c.table);
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

function clearListEntry(supabase: Parameters<typeof clearCoAdminListEntry>[0]["supabase"]) {
  return clearCoAdminListEntry({
    adminUserId: "admin-1",
    ownerUserId: "owner-1",
    supabase,
  });
}

/** Resolves to whatever the promise rejected with, so it can be inspected. */
function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected this to reject and it resolved");
    },
    (e: unknown) => e,
  );
}

describe("revoking a co-admin proves both deletes", () => {
  it("removes the wrapped key and the admin list row, filtered to that one admin", async () => {
    const { client, calls } = makeFakeClient(BOTH_REMOVED);

    await expect(revoke(client)).resolves.toBeUndefined();

    expect(calls).toHaveLength(2);

    const wdk = calls[0];
    expect(wdk.table).toBe("wrapped_data_keys");
    expect(wdk.filters).toEqual([
      { column: "data_key_id", value: "workspace-key-1" },
      { column: "recipient_user_id", value: "admin-1" },
    ]);
    // Asking for the removed rows back is the entire difference between a
    // revocation and a request that did not fail.
    expect(wdk.columns).toBe("recipient_user_id");

    const admins = calls[1];
    expect(admins.table).toBe("workspace_admins");
    expect(admins.filters).toEqual([
      { column: "owner_user_id", value: "owner-1" },
      { column: "admin_user_id", value: "admin-1" },
    ]);
    expect(admins.columns).toBe("admin_user_id");
  });

  it("removes the key row BEFORE the admin list row", async () => {
    const { client, calls } = makeFakeClient(BOTH_REMOVED);

    await revoke(client);

    // The key row is what grants access; the list row is the record of who
    // holds it. Stopping between the two must leave the evidence and not the
    // access, so this order is the safe one and the old order was not.
    expect(deletedTables(calls)).toEqual(["wrapped_data_keys", "workspace_admins"]);
  });

  it("says they still have access only when the key row is read back and is there", async () => {
    const { client, calls } = makeFakeClient({
      removed: { wrapped_data_keys: [], workspace_admins: [{ admin_user_id: "admin-1" }] },
      present: { wrapped_data_keys: [{ recipient_user_id: "admin-1" }] },
    });

    // This is the case the old code called success. The row is still there, so
    // the recipient still holds a validly signed grant and can still open the
    // owner's data, and this is the one branch entitled to say so.
    await expect(revoke(client)).rejects.toThrow(/still have access/);

    // It asked, rather than inferring it from a row count.
    const read = calls.find((c) => c.op === "select");
    expect(read?.table).toBe("wrapped_data_keys");
    expect(read?.filters).toEqual([
      { column: "data_key_id", value: "workspace-key-1" },
      { column: "recipient_user_id", value: "admin-1" },
    ]);

    // The admin list row survives on purpose: it is the only record of who
    // still holds access, and deleting it here would hide the problem while
    // leaving the access in place.
    expect(deletedTables(calls)).toEqual(["wrapped_data_keys"]);
  });

  it("does not claim they still have access when the key row cannot be found either", async () => {
    const { client, calls } = makeFakeClient({
      removed: { wrapped_data_keys: [], workspace_admins: [{ admin_user_id: "admin-1" }] },
      present: { wrapped_data_keys: [] },
    });

    // Nothing removed and nothing found. That cannot tell "there is no such
    // row" from "the row is there and the policy did not permit this delete",
    // and those mean opposite things to an owner, so it must claim neither.
    const error = await rejection(revoke(client));
    expect(error).toBeInstanceOf(CoAdminRevocationIncompleteError);
    expect((error as CoAdminRevocationIncompleteError).keyRemoved).toBe(false);
    expect((error as Error).message).not.toMatch(/still have access/);
    // The instruction that produced the dead end. It must not come back.
    expect((error as Error).message).not.toMatch(/again/i);

    expect(deletedTables(calls)).toEqual(["wrapped_data_keys"]);
  });

  it("offers the list-only removal instead of dead ending a second attempt", async () => {
    // The exact state a retry, a double click, or the recovery cleanup leaves
    // behind: the key is gone, the list entry is not. The owner must be able to
    // get out of it, and before this they could not: every attempt landed on
    // the branch above and was told the revocation had changed nothing.
    const { client } = makeFakeClient({
      removed: { wrapped_data_keys: [] },
      present: { wrapped_data_keys: [] },
    });

    const error = await rejection(revoke(client));
    expect(error).toBeInstanceOf(CoAdminRevocationIncompleteError);
    expect((error as Error).message).toMatch(/clear the list entry/i);
    expect((error as Error).message).toMatch(/does not remove access/i);
  });

  it("does not claim anything when the confirming read itself fails", async () => {
    const { client, calls } = makeFakeClient({
      removed: { wrapped_data_keys: [] },
      readErrors: { wrapped_data_keys: { message: "permission denied" } },
    });

    const error = await rejection(revoke(client));
    expect(error).toBeInstanceOf(CoAdminRevocationIncompleteError);
    expect((error as CoAdminRevocationIncompleteError).keyRemoved).toBe(false);
    expect((error as Error).message).toMatch(/not known/i);
    expect(deletedTables(calls)).toEqual(["wrapped_data_keys"]);
  });

  it("does not touch the admin list when the key delete errors", async () => {
    const { client, calls } = makeFakeClient({
      errors: { wrapped_data_keys: { message: "permission denied" } },
    });

    await expect(revoke(client)).rejects.toThrow(/wrapped_data_keys/);
    expect(deletedTables(calls)).toEqual(["wrapped_data_keys"]);
    // It did not go on to read the row back either: an error is already a
    // definite answer, unlike a row count of zero.
    expect(calls.filter((c) => c.op === "select")).toHaveLength(0);
  });

  it("says the stored key was removed, not that access was revoked, when only the list delete removes nothing", async () => {
    const { client } = makeFakeClient({
      removed: { wrapped_data_keys: [{ recipient_user_id: "admin-1" }], workspace_admins: [] },
    });

    // Half done, and which half decides what the owner should do. The stored
    // key is genuinely gone here. It is NOT true that access is revoked:
    // subkeys already loaded in a tab the co-admin left open keep working until
    // that tab closes, and those are the owner's live subkeys.
    const error = await rejection(revoke(client));
    expect(error).toBeInstanceOf(CoAdminRevocationIncompleteError);
    expect((error as CoAdminRevocationIncompleteError).keyRemoved).toBe(true);
    expect((error as Error).message).toMatch(/stored key was removed/i);
    expect((error as Error).message).toMatch(/tab/i);
    expect((error as Error).message).not.toMatch(/access was revoked/i);
  });

  it("says the stored key was removed when the list delete errors", async () => {
    const { client } = makeFakeClient({
      removed: { wrapped_data_keys: [{ recipient_user_id: "admin-1" }] },
      // A string, not an object: the code interpolates the error into a
      // template, so an object would arrive as [object Object] and the
      // assertion below could never see it.
      errors: { workspace_admins: "permission denied" },
    });

    const error = await rejection(revoke(client));
    expect(error).toBeInstanceOf(CoAdminRevocationIncompleteError);
    expect((error as CoAdminRevocationIncompleteError).keyRemoved).toBe(true);
    expect((error as Error).message).toMatch(/stored key was removed/i);
    expect((error as Error).message).toMatch(/permission denied/);
  });
});

describe("clearing a stale co-admin list entry", () => {
  it("removes the list row and nothing else, filtered to that one admin", async () => {
    const { client, calls } = makeFakeClient({
      removed: { workspace_admins: [{ admin_user_id: "admin-1" }] },
    });

    await expect(clearListEntry(client)).resolves.toBeUndefined();

    // The wrapped key is never touched here. This clears the record, and the
    // caller is responsible for saying so.
    expect(deletedTables(calls)).toEqual(["workspace_admins"]);
    expect(calls[0].filters).toEqual([
      { column: "owner_user_id", value: "owner-1" },
      { column: "admin_user_id", value: "admin-1" },
    ]);
    expect(calls[0].columns).toBe("admin_user_id");
  });

  it("fails when it removed no rows", async () => {
    const { client } = makeFakeClient({ removed: { workspace_admins: [] } });

    // The escape hatch must not fail the same silent way as the thing it is an
    // escape from.
    await expect(clearListEntry(client)).rejects.toThrow(/Nothing was removed/);
  });

  it("fails when the delete errors", async () => {
    const { client } = makeFakeClient({
      errors: { workspace_admins: { message: "permission denied" } },
    });

    await expect(clearListEntry(client)).rejects.toThrow(/permission denied/);
  });
});
