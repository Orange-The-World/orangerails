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
import { generateSigKeyPair } from "../signatures";
import { signMemberGrant } from "../member-grant";

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
  };
}

/** A fixed, valid-shaped owner signing public key. Not load-bearing for the
 * cases that never reach signature verification. */
const OWNER_SIG_PUB_B64 = "b3duZXItc2lnLXB1Yg==";

function persist(supabase: Parameters<typeof persistCoAdminGrant>[0]["supabase"]) {
  return persistCoAdminGrant({
    ownerUserId: "owner-1",
    targetUserId: "admin-1",
    workspaceKeyId: "workspace-key-1",
    wrappedCiphertextB64: "d3JhcHBlZA==",
    grantSig: "c2ln",
    ownerSigPubB64: OWNER_SIG_PUB_B64,
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

    await expect(persist(client)).resolves.toEqual({ alreadyGranted: false });

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
    // The fake throws on delete(), so reaching one fails this test loudly. An
    // error from a write is not proof the write did not land, only that its
    // answer did not come back, so compensating here is one of the ways the
    // dangerous state gets created rather than avoided.
    const { client, inserts } = makeFakeClient({
      errors: { wrapped_data_keys: { message: "network error" } },
    });

    await rejection(persist(client));

    expect(insertedTables(inserts)).toEqual(["workspace_admins", "wrapped_data_keys"]);
  });
});

describe("granting again after a stop is the remedy, not a second dead end", () => {
  it("treats an already-present list row as recorded and goes on to store the key", async () => {
    const { client, inserts } = makeFakeClient({ errors: { workspace_admins: UNIQUE_VIOLATION } });

    await expect(persist(client)).resolves.toEqual({ alreadyGranted: false });

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

describe("OR-T1942: a repeat grant to someone who already has a valid key", () => {
  const WORKSPACE_KEY_ID = "workspace-key-1";
  const TARGET_USER_ID = "admin-1";

  /** A fake client whose wrapped_data_keys insert always 23505s, and whose
   * select().eq().eq().single() returns the given existing row. */
  function makeDuplicateKeyClient(existingRow: { wrapped_ciphertext: string; grant_sig: string } | null) {
    const inserts: RecordedInsert[] = [];
    const client = {
      from(table: string) {
        return {
          insert(row: Record<string, unknown>) {
            inserts.push({ table, row });
            if (table === "wrapped_data_keys") {
              return Promise.resolve({
                data: null,
                error: {
                  code: "23505",
                  message:
                    'duplicate key value violates unique constraint "wrapped_data_keys_key_recipient_uniq"',
                },
              });
            }
            return Promise.resolve({ data: [row], error: null });
          },
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      single() {
                        return Promise.resolve(
                          existingRow
                            ? { data: existingRow, error: null }
                            : { data: null, error: { message: "no rows" } },
                        );
                      },
                    };
                  },
                };
              },
            };
          },
          delete() {
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
    };
  }

  it("reports alreadyGranted, not an error, when the existing row verifies against the current owner key", async () => {
    const owner = generateSigKeyPair();
    const ownerSigPubB64 = btoa(String.fromCharCode(...owner.publicKey));
    const wrappedCiphertextB64 = "ZXhpc3Rpbmctd3JhcHBlZA==";
    const { signature: grantSig } = await signMemberGrant(owner.secretKey, {
      memberUserId: TARGET_USER_ID,
      workspaceKeyId: WORKSPACE_KEY_ID,
      wrappedMekCiphertextB64: wrappedCiphertextB64,
    });
    const { client } = makeDuplicateKeyClient({ wrapped_ciphertext: wrappedCiphertextB64, grant_sig: grantSig });

    const result = await persistCoAdminGrant({
      ownerUserId: "owner-1",
      targetUserId: TARGET_USER_ID,
      workspaceKeyId: WORKSPACE_KEY_ID,
      wrappedCiphertextB64: "bmV3LWF0dGVtcHQ=",
      grantSig: "aXJyZWxldmFudA==",
      ownerSigPubB64,
      supabase: client,
    });

    expect(result).toEqual({ alreadyGranted: true });
  });

  it("still throws CoAdminGrantIncompleteError when the existing row does not verify", async () => {
    // Signed by a DIFFERENT key than the one passed as the current owner
    // signing key, the way a rotated or mismatched signer would look.
    const owner = generateSigKeyPair();
    const someoneElse = generateSigKeyPair();
    const ownerSigPubB64 = btoa(String.fromCharCode(...owner.publicKey));
    const wrappedCiphertextB64 = "ZXhpc3Rpbmctd3JhcHBlZA==";
    const { signature: grantSig } = await signMemberGrant(someoneElse.secretKey, {
      memberUserId: TARGET_USER_ID,
      workspaceKeyId: WORKSPACE_KEY_ID,
      wrappedMekCiphertextB64: wrappedCiphertextB64,
    });
    const { client } = makeDuplicateKeyClient({ wrapped_ciphertext: wrappedCiphertextB64, grant_sig: grantSig });

    const err = await rejection(
      persistCoAdminGrant({
        ownerUserId: "owner-1",
        targetUserId: TARGET_USER_ID,
        workspaceKeyId: WORKSPACE_KEY_ID,
        wrappedCiphertextB64: "bmV3LWF0dGVtcHQ=",
        grantSig: "aXJyZWxldmFudA==",
        ownerSigPubB64,
        supabase: client,
      }),
    );

    expect(err).toBeInstanceOf(CoAdminGrantIncompleteError);
  });

  it("throws CoAdminGrantIncompleteError when no existing row can be read back at all", async () => {
    const { client } = makeDuplicateKeyClient(null);

    const err = await rejection(
      persistCoAdminGrant({
        ownerUserId: "owner-1",
        targetUserId: TARGET_USER_ID,
        workspaceKeyId: WORKSPACE_KEY_ID,
        wrappedCiphertextB64: "bmV3LWF0dGVtcHQ=",
        grantSig: "aXJyZWxldmFudA==",
        ownerSigPubB64: OWNER_SIG_PUB_B64,
        supabase: client,
      }),
    );

    expect(err).toBeInstanceOf(CoAdminGrantIncompleteError);
  });
});
