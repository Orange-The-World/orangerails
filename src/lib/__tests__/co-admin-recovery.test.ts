/**
 * Tests for src/lib/co-admin-recovery.ts.
 *
 * WHAT IS BEING PINNED. A vault recovery makes every existing co-admin grant
 * undecryptable, silently, because the grant carries HKDF subkeys of the MEK
 * that the recovery just replaced. The chosen behaviour is to invalidate the
 * grants and tell the owner.
 *
 * Both halves matter and each is asserted in every case that has them. A grant
 * row left behind is a dead grant that looks alive, which is the original
 * defect. A grant removed with nobody told is a feature that silently stopped
 * working, which is barely better. So no test here asserts only that a row was
 * deleted, and none asserts only that a string came back.
 */

import { describe, it, expect } from "vitest";
import {
  invalidateCoAdminGrantsAfterRecovery,
  coAdminInvalidationMessage,
  type CoAdminRecoveryClient,
} from "../co-admin-recovery";

type QueryResult = { data: unknown[] | null; error: unknown };

interface RecordedCall {
  table: string;
  op: "select" | "delete";
  columns?: string;
  filters: Array<{ column: string; value: unknown }>;
}

interface Chain {
  then(
    onFulfilled: (value: QueryResult) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ): Promise<unknown>;
  eq(column: string, value: unknown): Chain;
}

interface FakeOptions {
  /** rows a select on each table returns */
  rows?: Record<string, unknown[]>;
  /** what a select returns instead of rows */
  selectResult?: Record<string, QueryResult>;
  /** what a delete on each table returns */
  deleteResult?: Record<string, QueryResult>;
}

/**
 * A fake supabase client that records what was asked of it. It reproduces only
 * the shapes this module uses: from().select().eq() and from().delete().eq().
 */
function makeFakeClient(options: FakeOptions = {}) {
  const calls: RecordedCall[] = [];

  function resultFor(call: RecordedCall): QueryResult {
    if (call.op === "select") {
      return (
        options.selectResult?.[call.table] ?? {
          data: options.rows?.[call.table] ?? [],
          error: null,
        }
      );
    }
    return options.deleteResult?.[call.table] ?? { data: [], error: null };
  }

  function chainFor(call: RecordedCall): Chain {
    const chain: Chain = {
      then(
        onFulfilled: (value: QueryResult) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        return Promise.resolve(resultFor(call)).then(onFulfilled, onRejected);
      },
      eq(column: string, value: unknown) {
        call.filters.push({ column, value });
        return chain;
      },
    };
    return chain;
  }

  const client = {
    from(table: string) {
      return {
        select(columns: string) {
          const call: RecordedCall = { table, op: "select", columns, filters: [] };
          calls.push(call);
          return chainFor(call);
        },
        delete() {
          const call: RecordedCall = { table, op: "delete", filters: [] };
          calls.push(call);
          return chainFor(call);
        },
      };
    },
  };

  return { client: client as CoAdminRecoveryClient, calls };
}

const TWO_GRANTS: FakeOptions = {
  rows: {
    wrapped_data_keys: [
      { recipient_user_id: "admin-1" },
      { recipient_user_id: "admin-2" },
    ],
  },
};

function invalidate(client: CoAdminRecoveryClient, workspaceKeyId: string | null = "workspace-key-1") {
  return invalidateCoAdminGrantsAfterRecovery({
    supabase: client,
    ownerUserId: "owner-1",
    workspaceKeyId,
  });
}

describe("a recovery invalidates every co-admin grant", () => {
  it("removes the wrapped keys AND the admin list, and tells the owner how many lost access", async () => {
    const { client, calls } = makeFakeClient(TWO_GRANTS);

    const result = await invalidate(client);

    // Half one: the dead key material is actually gone. A wrapped_data_keys row
    // that survives is a grant that unwraps cleanly and then decrypts nothing,
    // which is the exact failure this change exists to remove.
    const wdkDelete = calls.find((c) => c.table === "wrapped_data_keys" && c.op === "delete");
    expect(wdkDelete).toBeDefined();
    expect(wdkDelete?.filters).toContainEqual({
      column: "data_key_id",
      value: "workspace-key-1",
    });

    const adminDelete = calls.find((c) => c.table === "workspace_admins" && c.op === "delete");
    expect(adminDelete).toBeDefined();
    expect(adminDelete?.filters).toContainEqual({
      column: "owner_user_id",
      value: "owner-1",
    });

    // Half two: the owner is told, in words, with the number in them.
    expect(result).toEqual({ status: "invalidated", grantsInvalidated: 2 });
    const message = coAdminInvalidationMessage(result);
    expect(message).toContain("2 people");
    expect(message).toContain("Emergency access was reset");
  });

  it("says one person, not one people", async () => {
    const { client } = makeFakeClient({
      rows: { wrapped_data_keys: [{ recipient_user_id: "admin-1" }] },
    });

    const message = coAdminInvalidationMessage(await invalidate(client));

    expect(message).toContain("1 person");
  });

  it("deletes nothing and says nothing when the owner never granted access", async () => {
    const { client, calls } = makeFakeClient();

    const result = await invalidate(client, null);

    expect(result).toEqual({ status: "none" });
    expect(calls).toHaveLength(0);
    expect(coAdminInvalidationMessage(result)).toBeNull();
  });

  it("deletes nothing when a workspace key exists but carries no grants", async () => {
    const { client, calls } = makeFakeClient({ rows: { wrapped_data_keys: [] } });

    const result = await invalidate(client);

    expect(result).toEqual({ status: "none" });
    expect(calls.some((c) => c.op === "delete")).toBe(false);
    expect(coAdminInvalidationMessage(result)).toBeNull();
  });

  it("does not throw when the wrapped-key delete fails, and tells the owner what to do by hand", async () => {
    const { client, calls } = makeFakeClient({
      ...TWO_GRANTS,
      deleteResult: {
        wrapped_data_keys: { data: null, error: { message: "permission denied" } },
      },
    });

    // It must not throw. By the time this runs the recovery has already
    // succeeded, and reporting a cleanup failure as a failed recovery would
    // tell the user something false about the state of their vault.
    const result = await invalidate(client);

    expect(result.status).toBe("failed");
    expect(calls.some((c) => c.table === "workspace_admins" && c.op === "delete")).toBe(false);
    const message = coAdminInvalidationMessage(result);
    expect(message).toContain("no longer works");
    expect(message).toContain("Settings");
  });

  it("reports the half-done case precisely when only the admin list survives", async () => {
    const { client } = makeFakeClient({
      ...TWO_GRANTS,
      deleteResult: {
        workspace_admins: { data: null, error: { message: "permission denied" } },
      },
    });

    const result = await invalidate(client);

    expect(result.status).toBe("failed");
    // The dangerous half did succeed, and saying so is the difference between
    // an owner who knows the dead key material is gone and one who does not.
    if (result.status === "failed") {
      expect(result.reason).toContain("wrapped keys were removed");
    }
  });

  it("does not delete on a read it could not perform", async () => {
    const { client, calls } = makeFakeClient({
      selectResult: {
        wrapped_data_keys: { data: null, error: { message: "read failed" } },
      },
    });

    const result = await invalidate(client);

    // A read that failed says nothing about how many grants exist, so deleting
    // on the strength of it would be acting blind.
    expect(result.status).toBe("failed");
    expect(calls.some((c) => c.op === "delete")).toBe(false);
  });
});
