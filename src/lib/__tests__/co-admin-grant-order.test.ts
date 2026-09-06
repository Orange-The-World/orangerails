/**
 * Tests for the write ORDER inside a co-admin grant, in src/lib/co-admin.ts.
 *
 * WHAT IS BEING PINNED. A grant writes two rows. workspace_admins is the record
 * of who holds access; wrapped_data_keys IS the access. Until this change the
 * access was written first, so a stop between the two left a recipient holding
 * a validly ML-DSA-signed wrapped key that loadAdminSubkeysDirect would open,
 * and an owner whose list had no row for them and so was shown nothing to
 * revoke. Nothing about that state is visible to anyone, which is why it
 * survived. revokeCoAdmin already states the rule that forbids it, in its own
 * docstring in the same file, and obeys it. Grant did the opposite.
 *
 * WHY THESE CASES TARGET persistCoAdminGrant AND NOT grantCoAdmin. Every
 * database write a grant makes goes through that one helper, from a single call
 * site. Reaching it through grantCoAdmin means first satisfying the entire
 * crypto path ahead of it: a re-derived MEK, two HKDF subkeys, a hybrid KEM
 * public key for the recipient and an ML-DSA secret unwrapped from the owner's
 * vault. None of that has any bearing on the order of two inserts, and a
 * fixture large enough to get past it would spend most of its assertions on
 * itself. What this file therefore cannot prove on its own is that grantCoAdmin
 * still calls the helper at all. That is one line, and it is read rather than
 * inferred.
 *
 * WHAT A WEAKER TEST WOULD MISS. Asserting that both inserts happened passes
 * against the broken order too, because the broken order also inserts both
 * rows. So no case here asserts the mere existence of a call.
 */

import { describe, it, expect } from "vitest";
import { persistCoAdminGrant, CoAdminGrantIncompleteError } from "../co-admin";

interface RecordedInsert {
  table: string;
  row: Record<string, unknown>;
}

interface FakeOptions {
  /** an error the insert on this table returns, instead of succeeding */
  errors?: Record<string, unknown>;
}

function makeFakeClient(options: FakeOptions = {}) {
  const inserts: RecordedInsert[] = [];
  const deletes: string[] = [];

  const client = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          const error = options.errors?.[table] ?? null;
          return Promise.resolve({ data: error ? null : [row], error });
        },
        select() {
          throw new Error("a grant does not read; this client only records inserts");
        },
        delete() {
          deletes.push(table);
          throw new Error("a grant does not delete; see the note about compensating deletes");
        },
      };
    },
    rpc() {
      throw new Error("the workspace key id is already resolved before this helper is called");
    },
  };

  return {
    client: client as unknown as Parameters<typeof persistCoAdminGrant>[0]["supabase"],
    inserts,
    deletes,
  };
}

function persist(supabase: Parameters<typeof persistCoAdminGrant>[0]["supabase"]) {
  return persistCoAdminGrant({
    ownerUserId: "owner-1",
    targetUserId: "admin-1",
    workspaceKeyId: "workspace-key-1",
    wrappedCiphertextB64: "d3JhcHBlZA==",
    grantSig: "c2ln",
    supabase,
  });
}

/** The tables written to, in the order they were written. */
function insertedTables(inserts: RecordedInsert[]): string[] {
  return inserts.map((i) => i.table);
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

/** Postgres unique_violation, shaped the way PostgREST hands it back. */
const UNIQUE_VIOLATION = {
  code: "23505",
  message:
    'duplicate key value violates unique constraint "workspace_admins_owner_user_id_admin_user_id_key"',
};

describe("a co-admin grant writes the evidence before the access", () => {
  it("writes workspace_admins BEFORE wrapped_data_keys", async () => {
    const { client, inserts } = makeFakeClient();

    await expect(persist(client)).resolves.toBeUndefined();

    expect(insertedTables(inserts)).toEqual(["workspace_admins", "wrapped_data_keys"]);
  });

  it("writes each row with the fields its table needs", async () => {
    const { client, inserts } = makeFakeClient();

    await persist(client);

    expect(inserts[0].row).toEqual({ owner_user_id: "owner-1", admin_user_id: "admin-1" });
    expect(inserts[1].row).toEqual({
      data_key_id: "workspace-key-1",
      recipient_user_id: "admin-1",
      wrapped_ciphertext: "d3JhcHBlZA==",
      algorithm: "hybrid-x25519-mlkem768-blob64",
      grant_sig: "c2ln",
    });
  });
});

describe("a grant that stops half way leaves the evidence, never the access", () => {
  it("stores no key at all when the list row cannot be written", async () => {
    const { client, inserts } = makeFakeClient({
      errors: {
        workspace_admins: { code: "42501", message: "permission denied for table workspace_admins" },
      },
    });

    const err = await rejection(persist(client));

    expect(err).toBeInstanceOf(Error);
    // Not the incomplete-grant error: nothing was granted and nothing is left
    // behind, so there is no half-written state to describe.
    expect(err).not.toBeInstanceOf(CoAdminGrantIncompleteError);
    expect((err as Error).message).toContain("permission denied");
    // The assertion that matters is the absence of the second write.
    expect(insertedTables(inserts)).toEqual(["workspace_admins"]);
  });

  it("reports the list entry it left behind when the key cannot be stored", async () => {
    const { client, inserts } = makeFakeClient({
      errors: {
        wrapped_data_keys: {
          code: "42501",
          message: "new row violates row-level security policy for table wrapped_data_keys",
        },
      },
    });

    const err = await rejection(persist(client));

    expect(err).toBeInstanceOf(CoAdminGrantIncompleteError);
    const message = (err as Error).message;
    // The owner has to be told both halves. Either one on its own reads as the
    // opposite state: "added to your list" alone sounds like it worked, and
    // "they cannot open your data" alone sounds like nothing happened.
    expect(message).toContain("added to your list");
    expect(message).toContain("cannot open");
    // The Postgres message has to survive. Interpolating the error object
    // straight into the string, which is what this code used to do, renders
    // "[object Object]" to the owner and tells them nothing.
    expect(message).toContain("row-level security");
    expect(message).not.toContain("[object Object]");
  });

  it("does not delete the list row back out after the key write fails", async () => {
    // Delete calls are recorded on the fake and asserted directly, not just
    // inferred from the fake's throw: a compensating delete whose own error
    // gets caught and swallowed before it reaches the caller would still
    // leave insertedTables looking exactly like the passing case below, so
    // that assertion alone cannot fail if a delete is added. Recording calls
    // catches that case too.
    const { client, inserts, deletes } = makeFakeClient({
      errors: { wrapped_data_keys: { message: "network error" } },
    });

    await rejection(persist(client));

    expect(deletes).toEqual([]);
    expect(insertedTables(inserts)).toEqual(["workspace_admins", "wrapped_data_keys"]);
  });
});

describe("granting again after a stop is the remedy, not a second dead end", () => {
  it("treats an already-present list row as recorded and goes on to store the key", async () => {
    const { client, inserts } = makeFakeClient({ errors: { workspace_admins: UNIQUE_VIOLATION } });

    await expect(persist(client)).resolves.toBeUndefined();

    // Without this, the UNIQUE (owner_user_id, admin_user_id) constraint makes
    // the first write fail on every attempt after the first, the second write
    // is never reached, and the grant can never be completed by any means the
    // owner has.
    expect(insertedTables(inserts)).toEqual(["workspace_admins", "wrapped_data_keys"]);
  });

  it("still refuses a list-row failure that is not a duplicate", async () => {
    const { client, inserts } = makeFakeClient({
      errors: { workspace_admins: { code: "42501", message: "permission denied" } },
    });

    const err = await rejection(persist(client));

    expect(err).toBeInstanceOf(Error);
    // A blanket ignore would swallow this one too, and an RLS refusal means
    // something entirely different from a row that is already there.
    expect((err as Error).message).toContain("permission denied");
    expect(insertedTables(inserts)).toEqual(["workspace_admins"]);
  });
});
