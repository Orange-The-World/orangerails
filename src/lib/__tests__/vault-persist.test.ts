/**
 * Tests for the vault persist path in src/lib/vault-persist.ts.
 *
 * WHY THESE EXIST. Our crypto is well tested and the code that PERSISTS the
 * crypto's output was not tested at all. Every irreversible key-loss defect
 * found on this path so far has been in the second category, and the unit
 * suite was green on every commit while one of them sat on dev. So for this
 * family of defects a green suite was not evidence of anything.
 *
 * The property being pinned here is an ordering one, and it is the difference
 * between a failed recovery and a lost vault: nothing irreversible happens
 * until the user_vault_meta write is PROVEN to have landed. A supabase update
 * that matches zero rows returns no error, so the returned row count is the
 * only signal that it happened at all.
 */

import { describe, it, expect, vi } from "vitest";
import {
  migrateAndPersistRotatedVault,
  persistRewrappedVaultMeta,
  PASSWORD_CHANGE_CONFLICT_MESSAGE,
  PQC_SECRETS_NOT_CARRIED_MESSAGE,
  RECOVERY_META_NOT_SAVED_MESSAGE,
  VAULT_META_UNREADABLE_MESSAGE,
  type VaultPersistClient,
} from "../vault-persist";

type QueryResult = { data: unknown[] | null; error: unknown };

interface RecordedCall {
  table: string;
  op: "select" | "update";
  /** columns passed to .select(), which is what makes the row count readable */
  columns?: string;
  values?: Record<string, unknown>;
  filters: Array<{ column: string; value: unknown }>;
}

interface UpdateChain {
  then(
    onFulfilled: (value: QueryResult) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ): Promise<unknown>;
  eq(column: string, value: unknown): UpdateChain;
  select(columns: string): Promise<QueryResult>;
}

interface SelectChain {
  then(
    onFulfilled: (value: QueryResult) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ): Promise<unknown>;
  eq(column: string, value: unknown): SelectChain;
  range(from: number, to: number): Promise<QueryResult>;
}

interface FakeOptions {
  /** rows a select on each table returns */
  rows?: Record<string, unknown[]>;
  /** what the user_vault_meta update returns */
  metaUpdate?: QueryResult;
  /** what any other update returns */
  otherUpdate?: QueryResult;
  /** what a select returns instead of rows, for the error cases */
  selectResult?: Record<string, QueryResult>;
}

/**
 * A fake supabase client that records what was asked of it.
 *
 * It reproduces only the shape the persist code uses: from().select() with an
 * optional .range(), and from().update().eq().eq().select(). Every builder is
 * thenable, because the real client is awaited both with and without a
 * trailing .select().
 */
function makeFakeClient(options: FakeOptions = {}) {
  const calls: RecordedCall[] = [];

  function resultFor(call: RecordedCall): QueryResult {
    if (call.op === "select") {
      const override = options.selectResult?.[call.table];
      if (override) return override;
      return { data: options.rows?.[call.table] ?? [], error: null };
    }
    if (call.table === "user_vault_meta") {
      return options.metaUpdate ?? { data: [{ user_id: "user-1" }], error: null };
    }
    return options.otherUpdate ?? { data: [], error: null };
  }

  function thenable(call: RecordedCall) {
    return {
      then(
        onFulfilled: (value: QueryResult) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        return Promise.resolve(resultFor(call)).then(onFulfilled, onRejected);
      },
    };
  }

  const client = {
    from(table: string) {
      return {
        select(columns: string) {
          const call: RecordedCall = { table, op: "select", columns, filters: [] };
          calls.push(call);
          const chain: SelectChain = {
            ...thenable(call),
            eq(column: string, value: unknown) {
              call.filters.push({ column, value });
              return chain;
            },
            range(from: number, to: number) {
              call.filters.push({ column: "range", value: [from, to] });
              return Promise.resolve(resultFor(call));
            },
          };
          return chain;
        },
        update(values: Record<string, unknown>) {
          const call: RecordedCall = { table, op: "update", values, filters: [] };
          calls.push(call);
          const chain: UpdateChain = {
            ...thenable(call),
            eq(column: string, value: unknown) {
              call.filters.push({ column, value });
              return chain;
            },
            select(columns: string) {
              call.columns = columns;
              return Promise.resolve(resultFor(call));
            },
          };
          return chain;
        },
      };
    },
  };

  return { client: client as VaultPersistClient, calls };
}

/**
 * `pqc` defaults to a vault with no PQC keys, which is the case that leaves the
 * update carrying only the four wrapper columns. Tests that care about the
 * carried-across secrets pass them in explicitly.
 */
function rotateArgs(
  client: VaultPersistClient,
  clearMigrationKeys: () => void,
  pqc: { newKemSecretWrapped: string | null; newSigSecretWrapped: string | null } = {
    newKemSecretWrapped: null,
    newSigSecretWrapped: null,
  },
) {
  return {
    supabase: client,
    userId: "user-1",
    priorRecoveryCiphertext: "recovery-ciphertext-v0",
    newEncMekCiphertext: "enc-mek-v1",
    newRecoveryCiphertext: "recovery-ciphertext-v1",
    newVerifierCiphertext: "verifier-v1",
    vaultKeyVersion: 2,
    newKemSecretWrapped: pqc.newKemSecretWrapped,
    newSigSecretWrapped: pqc.newSigSecretWrapped,
    migrateCredentialsCiphertext: async (c: string) => `${c}-migrated`,
    migrateTransactionCiphertext: async (c: string) => `${c}-migrated`,
    clearMigrationKeys,
  };
}

/**
 * One connection to migrate, and a vault_meta row that exists and stores no PQC
 * secrets. The meta row is not decoration: the guard refuses a read that comes
 * back with no rows at all, because that means the row is not visible rather
 * than not there. A fixture without it describes a vault that cannot be
 * recovered, so every test built on it would be testing the refusal instead of
 * whatever it says it is testing.
 */
const oneConnection: FakeOptions = {
  rows: {
    connections: [{ id: "conn-1", encrypted_credentials: "creds-v0", encrypted_label: null }],
    user_vault_meta: [{ kem_secret_wrapped: null, sig_secret_wrapped: null }],
  },
};

describe("vault recovery: the rotated meta write", () => {
  it("throws and does NOT clear the migration keys when the update matches no row", async () => {
    const clearMigrationKeys = vi.fn();
    const { client } = makeFakeClient({
      ...oneConnection,
      metaUpdate: { data: [], error: null },
    });

    await expect(
      migrateAndPersistRotatedVault(rotateArgs(client, clearMigrationKeys)),
    ).rejects.toThrow(RECOVERY_META_NOT_SAVED_MESSAGE);

    // The whole point. Those stashed subkeys are the only thing that can still
    // read anything left under the old MEK in this session. Zeroing them here
    // is what turns a failed recovery into a lost vault.
    expect(clearMigrationKeys).not.toHaveBeenCalled();
  });

  it("throws and does NOT clear the migration keys when the update returns an error", async () => {
    const clearMigrationKeys = vi.fn();
    const { client } = makeFakeClient({
      ...oneConnection,
      metaUpdate: { data: null, error: { message: "boom" } },
    });

    await expect(
      migrateAndPersistRotatedVault(rotateArgs(client, clearMigrationKeys)),
    ).rejects.toBeTruthy();
    expect(clearMigrationKeys).not.toHaveBeenCalled();
  });

  it("clears the migration keys once the update matches exactly one row", async () => {
    const clearMigrationKeys = vi.fn();
    const { client } = makeFakeClient({
      ...oneConnection,
      metaUpdate: { data: [{ user_id: "user-1" }], error: null },
    });

    await migrateAndPersistRotatedVault(rotateArgs(client, clearMigrationKeys));

    expect(clearMigrationKeys).toHaveBeenCalledTimes(1);
  });

  it("asks for the updated rows back, because the row count is the only signal", async () => {
    const { client, calls } = makeFakeClient(oneConnection);

    await migrateAndPersistRotatedVault(rotateArgs(client, vi.fn()));

    const metaUpdate = calls.find((c) => c.table === "user_vault_meta" && c.op === "update");
    expect(metaUpdate?.columns).toBe("user_id");
  });

  it("guards the meta write with a compare-and-swap on the stored recovery ciphertext", async () => {
    const { client, calls } = makeFakeClient(oneConnection);

    await migrateAndPersistRotatedVault(rotateArgs(client, vi.fn()));

    const metaUpdate = calls.find((c) => c.table === "user_vault_meta" && c.op === "update");
    expect(metaUpdate?.filters).toContainEqual({ column: "user_id", value: "user-1" });
    expect(metaUpdate?.filters).toContainEqual({
      column: "recovery_ciphertext",
      value: "recovery-ciphertext-v0",
    });
  });

  it("writes the rotated verifier and key version, not just the wrappers", async () => {
    const { client, calls } = makeFakeClient(oneConnection);

    await migrateAndPersistRotatedVault(rotateArgs(client, vi.fn()));

    const metaUpdate = calls.find((c) => c.table === "user_vault_meta" && c.op === "update");
    expect(metaUpdate?.values).toEqual({
      enc_mek_ciphertext: "enc-mek-v1",
      recovery_ciphertext: "recovery-ciphertext-v1",
      vault_verifier_ciphertext: "verifier-v1",
      vault_key_version: 2,
    });
  });

  it("carries the re-wrapped PQC secrets in the SAME statement as the MEK wrappers", async () => {
    const { client, calls } = makeFakeClient(oneConnection);

    await migrateAndPersistRotatedVault(
      rotateArgs(client, vi.fn(), {
        newKemSecretWrapped: "kem-secret-v1",
        newSigSecretWrapped: "sig-secret-v1",
      }),
    );

    // One statement, not two, and this is the whole property. Those two columns
    // are wrapped under an HKDF subkey of the MEK, so the instant the wrappers
    // rotate without them the only key that opens them stops existing. A second
    // write would reopen that window; a write that omits them never closes it.
    const metaUpdates = calls.filter((c) => c.table === "user_vault_meta" && c.op === "update");
    expect(metaUpdates).toHaveLength(1);
    expect(metaUpdates[0]?.values).toEqual({
      enc_mek_ciphertext: "enc-mek-v1",
      recovery_ciphertext: "recovery-ciphertext-v1",
      vault_verifier_ciphertext: "verifier-v1",
      vault_key_version: 2,
      kem_secret_wrapped: "kem-secret-v1",
      sig_secret_wrapped: "sig-secret-v1",
    });
  });

  it("never writes null over a PQC column, only what it was given", async () => {
    const { client, calls } = makeFakeClient(oneConnection);

    await migrateAndPersistRotatedVault(
      rotateArgs(client, vi.fn(), {
        newKemSecretWrapped: null,
        newSigSecretWrapped: "sig-secret-v1",
      }),
    );

    // A vault with no PQC keys yet is the normal reason for null here. Passing
    // that null into the update would overwrite a real ciphertext with nothing
    // if a caller ever failed to read the columns first, which is the same
    // silent destruction this change exists to stop, arriving by another route.
    const metaUpdate = calls.find((c) => c.table === "user_vault_meta" && c.op === "update");
    expect(metaUpdate?.values).not.toHaveProperty("kem_secret_wrapped");
    expect(metaUpdate?.values).toHaveProperty("sig_secret_wrapped", "sig-secret-v1");
  });

  it("refuses, having changed nothing, when the caller would drop a stored PQC secret", async () => {
    const clearMigrationKeys = vi.fn();
    const { client, calls } = makeFakeClient({
      rows: {
        connections: [{ id: "conn-1", encrypted_credentials: "creds-v0", encrypted_label: null }],
        user_vault_meta: [
          { kem_secret_wrapped: "stored-kem", sig_secret_wrapped: "stored-sig" },
        ],
      },
    });

    // rotateArgs defaults both new values to null, which is exactly what a
    // caller that never selected the two columns would pass in.
    await expect(
      migrateAndPersistRotatedVault(rotateArgs(client, clearMigrationKeys)),
    ).rejects.toThrow(PQC_SECRETS_NOT_CARRIED_MESSAGE);

    // ZERO updates, and that is the property. A test that only checked it threw
    // would also pass for code that re-encrypted every row and then complained,
    // which is precisely the outcome this guard exists to prevent: by then the
    // old wrap key is gone and the PQC secrets are unreachable forever.
    expect(calls.filter((c) => c.op === "update")).toHaveLength(0);
    expect(clearMigrationKeys).not.toHaveBeenCalled();
  });

  it("checks each PQC column on its own, so dropping only the signature secret still refuses", async () => {
    const { client, calls } = makeFakeClient({
      rows: {
        connections: [{ id: "conn-1", encrypted_credentials: "creds-v0", encrypted_label: null }],
        user_vault_meta: [{ kem_secret_wrapped: null, sig_secret_wrapped: "stored-sig" }],
      },
    });

    await expect(
      migrateAndPersistRotatedVault(
        rotateArgs(client, vi.fn(), {
          newKemSecretWrapped: null,
          newSigSecretWrapped: null,
        }),
      ),
    ).rejects.toThrow(PQC_SECRETS_NOT_CARRIED_MESSAGE);

    expect(calls.filter((c) => c.op === "update")).toHaveLength(0);
  });

  it("does not refuse a vault that has no PQC keys stored, which is the normal null case", async () => {
    const { client, calls } = makeFakeClient({
      rows: {
        connections: [{ id: "conn-1", encrypted_credentials: "creds-v0", encrypted_label: null }],
        user_vault_meta: [{ kem_secret_wrapped: null, sig_secret_wrapped: null }],
      },
    });

    await expect(
      migrateAndPersistRotatedVault(rotateArgs(client, vi.fn())),
    ).resolves.toBeUndefined();

    expect(calls.some((c) => c.table === "user_vault_meta" && c.op === "update")).toBe(true);
  });

  it("proceeds when the caller did carry the stored PQC secrets across", async () => {
    const { client, calls } = makeFakeClient({
      rows: {
        connections: [{ id: "conn-1", encrypted_credentials: "creds-v0", encrypted_label: null }],
        user_vault_meta: [
          { kem_secret_wrapped: "stored-kem", sig_secret_wrapped: "stored-sig" },
        ],
      },
    });

    await migrateAndPersistRotatedVault(
      rotateArgs(client, vi.fn(), {
        newKemSecretWrapped: "kem-secret-v1",
        newSigSecretWrapped: "sig-secret-v1",
      }),
    );

    const metaUpdate = calls.find((c) => c.table === "user_vault_meta" && c.op === "update");
    expect(metaUpdate?.values).toHaveProperty("kem_secret_wrapped", "kem-secret-v1");
    expect(metaUpdate?.values).toHaveProperty("sig_secret_wrapped", "sig-secret-v1");
  });

  it("reads the guard row for this user and asks for both PQC columns", async () => {
    const { client, calls } = makeFakeClient(oneConnection);

    await migrateAndPersistRotatedVault(rotateArgs(client, vi.fn()));

    const guardRead = calls.find((c) => c.table === "user_vault_meta" && c.op === "select");
    expect(guardRead?.columns).toBe("kem_secret_wrapped, sig_secret_wrapped");
    expect(guardRead?.filters).toContainEqual({ column: "user_id", value: "user-1" });
  });

  it("stops, changing nothing, when the guard read itself fails", async () => {
    const { client, calls } = makeFakeClient({
      ...oneConnection,
      selectResult: {
        user_vault_meta: { data: null, error: { message: "guard read failed" } },
      },
    });

    // A guard that cannot see the stored row must not shrug and continue: it
    // cannot tell a vault with no PQC keys from one whose keys are about to be
    // discarded, so refusing is the only honest answer.
    await expect(
      migrateAndPersistRotatedVault(rotateArgs(client, vi.fn())),
    ).rejects.toBeTruthy();

    expect(calls.filter((c) => c.op === "update")).toHaveLength(0);
  });

  it("stops, changing nothing, when the guard read comes back with no row", async () => {
    const clearMigrationKeys = vi.fn();
    const { client, calls } = makeFakeClient({
      rows: {
        connections: [{ id: "conn-1", encrypted_credentials: "creds-v0", encrypted_label: null }],
        user_vault_meta: [],
      },
    });

    // Zero rows is not "this vault stores no post-quantum secrets". It is "the
    // row is not visible from here", which is a different fact and can be true
    // of a vault that stores them. Treating the two as the same is the one way
    // past this guard, and everything past this guard is irreversible.
    await expect(
      migrateAndPersistRotatedVault(rotateArgs(client, clearMigrationKeys)),
    ).rejects.toThrow(VAULT_META_UNREADABLE_MESSAGE);

    // Zero updates, the same standard as the read-error case above. Asserting
    // only that it threw would also pass for code that re-encrypted every row
    // and complained afterwards, when the old wrap key is already gone.
    expect(calls.filter((c) => c.op === "update")).toHaveLength(0);
    expect(clearMigrationKeys).not.toHaveBeenCalled();
  });

  it("migrates every row BEFORE the meta write, never after", async () => {
    const { client, calls } = makeFakeClient({
      rows: {
        connections: [{ id: "conn-1", encrypted_credentials: "creds-v0", encrypted_label: null }],
        encrypted_transactions: [{ id: "txn-1", encrypted_payload: "payload-v0" }],
        user_vault_meta: [{ kem_secret_wrapped: null, sig_secret_wrapped: null }],
      },
    });

    await migrateAndPersistRotatedVault(rotateArgs(client, vi.fn()));

    const metaIndex = calls.findIndex((c) => c.table === "user_vault_meta" && c.op === "update");
    const rowUpdates = calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.op === "update" && c.table !== "user_vault_meta");

    expect(rowUpdates.length).toBe(2);
    for (const { i } of rowUpdates) expect(i).toBeLessThan(metaIndex);
  });

  it("re-encrypts the connection credentials with the migration helper", async () => {
    const { client, calls } = makeFakeClient(oneConnection);

    await migrateAndPersistRotatedVault(rotateArgs(client, vi.fn()));

    const connUpdate = calls.find((c) => c.table === "connections" && c.op === "update");
    expect(connUpdate?.values).toEqual({ encrypted_credentials: "creds-v0-migrated" });
  });

  it("does not reach the meta write at all if a row migration throws", async () => {
    const clearMigrationKeys = vi.fn();
    const { client, calls } = makeFakeClient(oneConnection);
    const args = {
      ...rotateArgs(client, clearMigrationKeys),
      migrateCredentialsCiphertext: async () => {
        throw new Error("decrypt failed");
      },
    };

    await expect(migrateAndPersistRotatedVault(args)).rejects.toThrow("decrypt failed");

    expect(calls.some((c) => c.table === "user_vault_meta" && c.op === "update")).toBe(false);
    expect(clearMigrationKeys).not.toHaveBeenCalled();
  });
});

describe("vault password change: the re-wrapped meta write", () => {
  function rewrapArgs(client: VaultPersistClient) {
    return {
      supabase: client,
      userId: "user-1",
      priorEncMekCiphertext: "enc-mek-v0",
      newEncMekCiphertext: "enc-mek-v1",
      newRecoveryCiphertext: "recovery-ciphertext-v1",
    };
  }

  it("throws when the update matches no row, so a dead recovery code is never shown", async () => {
    const { client } = makeFakeClient({ metaUpdate: { data: [], error: null } });

    await expect(persistRewrappedVaultMeta(rewrapArgs(client))).rejects.toThrow(
      PASSWORD_CHANGE_CONFLICT_MESSAGE,
    );
  });

  it("throws when the update returns an error", async () => {
    const { client } = makeFakeClient({
      metaUpdate: { data: null, error: { message: "boom" } },
    });

    await expect(persistRewrappedVaultMeta(rewrapArgs(client))).rejects.toThrow("boom");
  });

  it("resolves when the update matches a row", async () => {
    const { client } = makeFakeClient({
      metaUpdate: { data: [{ user_id: "user-1" }], error: null },
    });

    await expect(persistRewrappedVaultMeta(rewrapArgs(client))).resolves.toBeUndefined();
  });

  it("asks for the updated rows back and guards on the prior wrapped MEK", async () => {
    const { client, calls } = makeFakeClient();

    await persistRewrappedVaultMeta(rewrapArgs(client));

    const metaUpdate = calls.find((c) => c.table === "user_vault_meta" && c.op === "update");
    expect(metaUpdate?.columns).toBe("user_id");
    expect(metaUpdate?.filters).toContainEqual({ column: "user_id", value: "user-1" });
    expect(metaUpdate?.filters).toContainEqual({
      column: "enc_mek_ciphertext",
      value: "enc-mek-v0",
    });
  });

  it("does not touch any table other than user_vault_meta", async () => {
    const { client, calls } = makeFakeClient();

    await persistRewrappedVaultMeta(rewrapArgs(client));

    expect(calls.every((c) => c.table === "user_vault_meta")).toBe(true);
  });
});
