import { describe, it, expect } from "vitest";
import { persistCoAdminGrant, type CoAdminSupabaseLike } from "./co-admin";

interface WrappedKeyRow {
  data_key_id: string;
  recipient_user_id: string;
  wrapped_ciphertext: string;
  algorithm: string;
  grant_sig: string;
}

interface AdminRow {
  owner_user_id: string;
  admin_user_id: string;
}

/**
 * A fake Supabase client that models the real state persistCoAdminGrant
 * depends on, as actual in-memory tables rather than a call-recording mock:
 *
 *   - wrapped_data_keys carries UNIQUE (data_key_id, recipient_user_id),
 *     added in #973 / DEV-0412. An insert that collides with an existing
 *     row returns a Postgres-shaped 23505 error, exactly like PostgREST does.
 *   - workspace_admins carries UNIQUE (owner_user_id, admin_user_id), same
 *     shape.
 *   - delete() removes matching rows and is scoped by every .eq() chained
 *     onto it, so a delete filtered on the wrong pair leaves rows behind.
 *
 * This is deliberate: a fake that just recorded "insert was called" would
 * still pass if the self-heal delete were removed entirely, or if it were
 * scoped to the wrong recipient. These tests only pass if the stale row is
 * genuinely gone before the insert that replaces it.
 */
function makeFakeSupabase(
  initialWrappedKeys: WrappedKeyRow[] = [],
  initialAdmins: AdminRow[] = [],
): {
  supabase: CoAdminSupabaseLike;
  wrappedKeys: WrappedKeyRow[];
  admins: AdminRow[];
} {
  const wrappedKeys = [...initialWrappedKeys];
  const admins = [...initialAdmins];

  function makeDeleteBuilder(rows: Record<string, unknown>[]) {
    const filters: Array<[string, string]> = [];
    const builder = {
      eq(col: string, val: string) {
        filters.push([col, val]);
        return builder;
      },
      then(fn: (v: { error: unknown }) => void) {
        for (let i = rows.length - 1; i >= 0; i--) {
          if (filters.every(([col, val]) => rows[i][col] === val)) {
            rows.splice(i, 1);
          }
        }
        return Promise.resolve(fn({ error: null }));
      },
      select() {
        throw new Error("not used in this test");
      },
    };
    return builder;
  }

  const supabase: CoAdminSupabaseLike = {
    from(table: string) {
      if (table === "workspace_admins") {
        return {
          select() {
            throw new Error("not used in this test");
          },
          insert(row: Record<string, unknown>) {
            const exists = admins.some(
              (a) =>
                a.owner_user_id === row.owner_user_id && a.admin_user_id === row.admin_user_id,
            );
            if (exists) {
              return Promise.resolve({
                data: null,
                error: { code: "23505", message: "duplicate key value violates unique constraint" },
              });
            }
            admins.push(row as AdminRow);
            return Promise.resolve({ data: [row], error: null });
          },
          delete() {
            return makeDeleteBuilder(admins as unknown as Record<string, unknown>[]);
          },
        } as unknown as ReturnType<CoAdminSupabaseLike["from"]>;
      }
      if (table === "wrapped_data_keys") {
        return {
          select() {
            throw new Error("not used in this test");
          },
          insert(row: Record<string, unknown>) {
            const exists = wrappedKeys.some(
              (k) =>
                k.data_key_id === row.data_key_id && k.recipient_user_id === row.recipient_user_id,
            );
            if (exists) {
              return Promise.resolve({
                data: null,
                error: { code: "23505", message: "duplicate key value violates unique constraint" },
              });
            }
            wrappedKeys.push(row as WrappedKeyRow);
            return Promise.resolve({ data: [row], error: null });
          },
          delete() {
            return makeDeleteBuilder(wrappedKeys as unknown as Record<string, unknown>[]);
          },
        } as unknown as ReturnType<CoAdminSupabaseLike["from"]>;
      }
      throw new Error(`unexpected table: ${table}`);
    },
    rpc() {
      throw new Error("not used in this test");
    },
  };

  return { supabase, wrappedKeys, admins };
}

const OWNER = "owner-1";
const RECIPIENT = "recipient-1";
const OTHER_RECIPIENT = "recipient-2";
const WORKSPACE_KEY_ID = "wk-1";

describe("persistCoAdminGrant self-heal (DEV-0416)", () => {
  it("replaces a stranded wrapped_data_keys row instead of failing on the unique constraint", async () => {
    const stale: WrappedKeyRow = {
      data_key_id: WORKSPACE_KEY_ID,
      recipient_user_id: RECIPIENT,
      wrapped_ciphertext: "stale-ciphertext",
      algorithm: "hybrid-x25519-mlkem768-blob64",
      grant_sig: "stale-sig",
    };
    const { supabase, wrappedKeys, admins } = makeFakeSupabase([stale]);

    await persistCoAdminGrant({
      ownerUserId: OWNER,
      targetUserId: RECIPIENT,
      workspaceKeyId: WORKSPACE_KEY_ID,
      wrappedCiphertextB64: "fresh-ciphertext",
      grantSig: "fresh-sig",
      supabase,
    });

    const rowsForPair = wrappedKeys.filter(
      (k) => k.data_key_id === WORKSPACE_KEY_ID && k.recipient_user_id === RECIPIENT,
    );
    expect(rowsForPair).toHaveLength(1);
    expect(rowsForPair[0].wrapped_ciphertext).toBe("fresh-ciphertext");
    expect(rowsForPair[0].grant_sig).toBe("fresh-sig");
    expect(admins).toContainEqual({ owner_user_id: OWNER, admin_user_id: RECIPIENT });
  });

  it("does not touch a stranded row belonging to a different recipient", async () => {
    const otherRecipientRow: WrappedKeyRow = {
      data_key_id: WORKSPACE_KEY_ID,
      recipient_user_id: OTHER_RECIPIENT,
      wrapped_ciphertext: "other-ciphertext",
      algorithm: "hybrid-x25519-mlkem768-blob64",
      grant_sig: "other-sig",
    };
    const { supabase, wrappedKeys } = makeFakeSupabase([otherRecipientRow]);

    await persistCoAdminGrant({
      ownerUserId: OWNER,
      targetUserId: RECIPIENT,
      workspaceKeyId: WORKSPACE_KEY_ID,
      wrappedCiphertextB64: "fresh-ciphertext",
      grantSig: "fresh-sig",
      supabase,
    });

    expect(wrappedKeys).toContainEqual(otherRecipientRow);
    expect(
      wrappedKeys.some(
        (k) => k.recipient_user_id === RECIPIENT && k.wrapped_ciphertext === "fresh-ciphertext",
      ),
    ).toBe(true);
  });

  it("self-heals on a retry after a partial failure left both the admin row and a stale envelope behind", async () => {
    // Models the exact stranded state this ticket describes: workspace_admins
    // succeeded on a first attempt, wrapped_data_keys did not, and the caller
    // retries with a freshly wrapped and signed blob.
    const stale: WrappedKeyRow = {
      data_key_id: WORKSPACE_KEY_ID,
      recipient_user_id: RECIPIENT,
      wrapped_ciphertext: "stale-ciphertext",
      algorithm: "hybrid-x25519-mlkem768-blob64",
      grant_sig: "stale-sig",
    };
    const { supabase, wrappedKeys, admins } = makeFakeSupabase(
      [stale],
      [{ owner_user_id: OWNER, admin_user_id: RECIPIENT }],
    );

    await persistCoAdminGrant({
      ownerUserId: OWNER,
      targetUserId: RECIPIENT,
      workspaceKeyId: WORKSPACE_KEY_ID,
      wrappedCiphertextB64: "retry-ciphertext",
      grantSig: "retry-sig",
      supabase,
    });

    expect(admins).toHaveLength(1);
    const rowsForPair = wrappedKeys.filter(
      (k) => k.data_key_id === WORKSPACE_KEY_ID && k.recipient_user_id === RECIPIENT,
    );
    expect(rowsForPair).toHaveLength(1);
    expect(rowsForPair[0].wrapped_ciphertext).toBe("retry-ciphertext");
  });
});
