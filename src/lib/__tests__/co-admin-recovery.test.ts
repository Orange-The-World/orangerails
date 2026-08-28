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
 *
 * WHAT THE FIXTURES MODEL, and why it is not an arbitrary choice. In the real
 * database the owner CANNOT read wrapped_data_keys: its only select policy is
 * recipient scoped, so an owner selecting their own grants gets zero rows and
 * no error. They CAN delete those rows, and they can both read and delete
 * workspace_admins. Every fixture below matches that, which is why a select on
 * wrapped_data_keys returns nothing here and the rows arrive from the delete.
 * A fixture that let the owner read that table would let a test pass over code
 * that does nothing in production, which is exactly what happened before.
 *
 * The same is true of the name lookup. get_coadmin_emails returns a row only
 * while a workspace_admins row still links the caller to that user, so the
 * fixtures treat it as answerable before the deletes and worthless after them,
 * and one test asserts the order rather than trusting the code to keep it.
 */

import { describe, it, expect } from "vitest";
import {
  invalidateCoAdminGrantsAfterRecovery,
  coAdminInvalidationMessage,
  type CoAdminRecoveryClient,
} from "../co-admin-recovery";

type QueryResult = { data: unknown[] | null; error: unknown };

interface RecordedCall {
  /** table name for a select or delete, rpc function name for an rpc */
  table: string;
  op: "select" | "delete" | "rpc";
  columns?: string;
  filters: Array<{ column: string; value: unknown }>;
  args?: Record<string, unknown>;
}

interface Chain {
  then(
    onFulfilled: (value: QueryResult) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ): Promise<unknown>;
  eq(column: string, value: unknown): Chain;
  select(columns: string): Chain;
}

interface FakeOptions {
  /** rows each table holds: what a select returns, and what a delete removes */
  rows?: Record<string, unknown[]>;
  /** what a select returns instead of rows */
  selectResult?: Record<string, QueryResult>;
  /** what a delete on each table returns */
  deleteResult?: Record<string, QueryResult>;
  /** user id to email, as get_coadmin_emails would answer it */
  emails?: Record<string, string>;
  /** give the client no rpc at all, the way an older caller would */
  withoutRpc?: boolean;
  /** make the rpc return an error instead of rows */
  rpcError?: unknown;
  /** make the rpc throw rather than resolve */
  rpcThrows?: boolean;
}

/**
 * A fake supabase client that records what was asked of it, in order. It
 * reproduces only the shapes this module uses: from().select().eq(),
 * from().delete().eq(), from().delete().eq().select() (a delete that asks for
 * the rows it removed) and rpc().
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
    // A delete returns the rows it removed, which is the rows that were there.
    return (
      options.deleteResult?.[call.table] ?? {
        data: options.rows?.[call.table] ?? [],
        error: null,
      }
    );
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
      select(columns: string) {
        call.columns = columns;
        return chain;
      },
    };
    return chain;
  }

  const client: Record<string, unknown> = {
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

  if (!options.withoutRpc) {
    client.rpc = async (fn: string, args: Record<string, unknown>) => {
      calls.push({ table: fn, op: "rpc", filters: [], args });
      if (options.rpcThrows) throw new Error("network");
      if (options.rpcError) return { data: null, error: options.rpcError };
      const ids = (args.user_ids ?? []) as string[];
      const rows = ids
        .filter((id) => options.emails?.[id])
        .map((id) => ({ user_id: id, email: options.emails?.[id] }));
      return { data: rows, error: null };
    };
  }

  return { client: client as unknown as CoAdminRecoveryClient, calls };
}

/** Two people hold emergency access, and the owner cannot read the key rows. */
const TWO_GRANTS: FakeOptions = {
  rows: {
    workspace_admins: [{ admin_user_id: "admin-1" }, { admin_user_id: "admin-2" }],
  },
  selectResult: {
    wrapped_data_keys: { data: [], error: null },
  },
  deleteResult: {
    wrapped_data_keys: {
      data: [{ recipient_user_id: "admin-1" }, { recipient_user_id: "admin-2" }],
      error: null,
    },
  },
  emails: { "admin-1": "ana@example.com", "admin-2": "ben@example.com" },
};

function invalidate(
  client: CoAdminRecoveryClient,
  workspaceKeyId: string | null = "workspace-key-1",
) {
  return invalidateCoAdminGrantsAfterRecovery({
    supabase: client,
    ownerUserId: "owner-1",
    workspaceKeyId,
  });
}

describe("a recovery invalidates every co-admin grant", () => {
  it("removes the wrapped keys AND the admin list, and tells the owner who lost access", async () => {
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
    // It asks for the removed rows back. Without that the count is a guess.
    expect(wdkDelete?.columns).toBe("recipient_user_id");

    const adminDelete = calls.find((c) => c.table === "workspace_admins" && c.op === "delete");
    expect(adminDelete).toBeDefined();
    expect(adminDelete?.filters).toContainEqual({
      column: "owner_user_id",
      value: "owner-1",
    });

    // Half two: the owner is told, in words, and the words name the people. The
    // two ids are the ones the DELETE gave back, and the fixture makes a select
    // on that table return nothing, so they cannot have come from a read.
    expect(result).toEqual({
      status: "invalidated",
      grantsInvalidated: 2,
      people: ["ana@example.com", "ben@example.com"],
    });
    const message = coAdminInvalidationMessage(result);
    expect(message).toContain("ana@example.com and ben@example.com");
    expect(message).toContain("Emergency access was reset");
  });

  it("looks the names up BEFORE it deletes the rows that make the lookup possible", async () => {
    const { client, calls } = makeFakeClient(TWO_GRANTS);

    await invalidate(client);

    // get_coadmin_emails answers only while a workspace_admins row still links
    // the caller to that user. Called after the cleanup it returns an empty set
    // with no error, so the owner would be asked to re-grant access to a list
    // we had just made unresolvable. The order is the whole property.
    const rpcAt = calls.findIndex((c) => c.op === "rpc" && c.table === "get_coadmin_emails");
    const firstDeleteAt = calls.findIndex((c) => c.op === "delete");
    expect(rpcAt).toBeGreaterThanOrEqual(0);
    expect(firstDeleteAt).toBeGreaterThanOrEqual(0);
    expect(rpcAt).toBeLessThan(firstDeleteAt);
    expect(calls[rpcAt].args).toEqual({ user_ids: ["admin-1", "admin-2"] });
  });

  it("never selects wrapped_data_keys, because the owner is not permitted to read it", async () => {
    const { client, calls } = makeFakeClient(TWO_GRANTS);

    await invalidate(client);

    // The only select policy on that table is recipient scoped, so this read
    // returns an empty set with no error when the owner runs it. Gating the
    // cleanup on it is what made the whole feature inert.
    expect(calls.some((c) => c.table === "wrapped_data_keys" && c.op === "select")).toBe(false);
  });

  it("names one person with the singular verb", async () => {
    const { client } = makeFakeClient({
      rows: { workspace_admins: [{ admin_user_id: "admin-1" }] },
      selectResult: { wrapped_data_keys: { data: [], error: null } },
      deleteResult: {
        wrapped_data_keys: { data: [{ recipient_user_id: "admin-1" }], error: null },
      },
      emails: { "admin-1": "ana@example.com" },
    });

    const message = coAdminInvalidationMessage(await invalidate(client));

    expect(message).toContain("ana@example.com no longer has it");
  });

  it("falls back to the short id when the client cannot resolve names at all", async () => {
    const { client, calls } = makeFakeClient({
      ...TWO_GRANTS,
      rows: { workspace_admins: [{ admin_user_id: "abcdefgh-1111-2222" }] },
      deleteResult: {
        wrapped_data_keys: { data: [{ recipient_user_id: "abcdefgh-1111-2222" }], error: null },
      },
      withoutRpc: true,
    });

    const result = await invalidate(client);

    // Not being able to pretty-print a name is not a reason to leave dead key
    // material in place, and the short id is what Settings shows anyway.
    expect(result.status).toBe("invalidated");
    expect(calls.some((c) => c.op === "rpc")).toBe(false);
    expect(coAdminInvalidationMessage(result)).toContain("abcdefgh…");
  });

  it("still cleans up, and still names people, when the name lookup errors", async () => {
    const { client } = makeFakeClient({
      ...TWO_GRANTS,
      rpcError: { message: "permission denied" },
    });

    const result = await invalidate(client);

    expect(result.status).toBe("invalidated");
    expect(coAdminInvalidationMessage(result)).toContain("admin-1…");
  });

  it("still cleans up when the name lookup throws", async () => {
    const { client } = makeFakeClient({ ...TWO_GRANTS, rpcThrows: true });

    const result = await invalidate(client);

    expect(result.status).toBe("invalidated");
    if (result.status === "invalidated") {
      expect(result.grantsInvalidated).toBe(2);
    }
  });

  it("deletes nothing and says nothing when the owner never granted access", async () => {
    const { client, calls } = makeFakeClient();

    const result = await invalidate(client, null);

    expect(result).toEqual({ status: "none" });
    expect(calls).toHaveLength(0);
    expect(coAdminInvalidationMessage(result)).toBeNull();
  });

  it("deletes nothing when a workspace key exists but nobody holds emergency access", async () => {
    const { client, calls } = makeFakeClient({ rows: { workspace_admins: [] } });

    const result = await invalidate(client);

    expect(result).toEqual({ status: "none" });
    expect(calls.some((c) => c.op === "delete")).toBe(false);
    // Nobody to name, so nothing to look up.
    expect(calls.some((c) => c.op === "rpc")).toBe(false);
    expect(coAdminInvalidationMessage(result)).toBeNull();
  });

  it("reports failed, and keeps the admin list, when the delete removes nothing while people are listed", async () => {
    const { client, calls } = makeFakeClient({
      ...TWO_GRANTS,
      deleteResult: {
        wrapped_data_keys: { data: [], error: null },
      },
    });

    const result = await invalidate(client);

    // No error came back, and nothing was removed. Reporting that as "none"
    // is what a check that cannot fire looks like from the outside.
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("2 people are still listed");
      // The owner has to remove these two by hand, so they are named.
      expect(result.people).toEqual(["ana@example.com", "ben@example.com"]);
    }
    // The admin list survives on purpose: it is the only record of who the
    // owner now has to remove by hand, and the message asks them to.
    expect(calls.some((c) => c.table === "workspace_admins" && c.op === "delete")).toBe(false);
    const message = coAdminInvalidationMessage(result);
    expect(message).toContain("Settings");
    expect(message).toContain("ana@example.com");
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

  it("reports the half-done case precisely when the admin delete errors", async () => {
    const { client } = makeFakeClient({
      ...TWO_GRANTS,
      deleteResult: {
        ...TWO_GRANTS.deleteResult,
        workspace_admins: { data: null, error: { message: "permission denied" } },
      },
    });

    const result = await invalidate(client);

    expect(result.status).toBe("failed");
    // The dangerous half did succeed, and saying so is the difference between
    // an owner who knows the dead key material is gone and one who does not.
    if (result.status === "failed") {
      expect(result.reason).toContain("wrapped keys were removed");
      expect(result.people).toEqual(["ana@example.com", "ben@example.com"]);
    }
  });

  it("treats an admin delete that removed no rows as a failure, not a success", async () => {
    const { client } = makeFakeClient({
      ...TWO_GRANTS,
      deleteResult: {
        ...TWO_GRANTS.deleteResult,
        workspace_admins: { data: [], error: null },
      },
    });

    const result = await invalidate(client);

    // Same standard as the wrapped-key delete: no error is not proof.
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("wrapped keys were removed");
    }
  });

  it("does not delete on a read it could not perform", async () => {
    const { client, calls } = makeFakeClient({
      selectResult: {
        workspace_admins: { data: null, error: { message: "read failed" } },
      },
    });

    const result = await invalidate(client);

    // A read that failed says nothing about who holds emergency access, so
    // deleting on the strength of it would be acting blind.
    expect(result.status).toBe("failed");
    expect(calls.some((c) => c.op === "delete")).toBe(false);
    // And nothing is named, because we do not know who. An empty list is the
    // honest answer, not a guess dressed up as one.
    if (result.status === "failed") {
      expect(result.people).toEqual([]);
    }
  });
});
