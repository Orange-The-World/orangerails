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
  RECOVERY_META_NOT_SAVED_MESSAGE,
  TRANSACTION_PAGE_SIZE,
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
          return {
            ...thenable(call),
            /**
             * The real client's .range(from, to) is an INCLUSIVE window, so the
             * fake slices. It used to record its arguments and then ignore them,
             * returning the same rows on every call. That made the paging loop in
             * migrateAndPersistRotatedVault impossible to test: a fixture big
             * enough to force a second page came back again on that page, and
             * again forever, so the short-page break could never fire and the
             * suite HUNG instead of failing. An error or a null-data override is
             * passed straight through, because there is nothing to slice and the
             * failure is the thing under test.
             */
            range(from: number, to: number) {
              call.filters.push({ column: "range", value: [from, to] });
              const base = resultFor(call);
              if (base.error || !base.data) return Promise.resolve(base);
              return Promise.resolve({ data: base.data.slice(from, to + 1), error: null });
            },
          };
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

function rotateArgs(client: VaultPersistClient, clearMigrationKeys: () => void) {
  return {
    supabase: client,
    userId: "user-1",
    priorRecoveryCiphertext: "recovery-ciphertext-v0",
    newEncMekCiphertext: "enc-mek-v1",
    newRecoveryCiphertext: "recovery-ciphertext-v1",
    newVerifierCiphertext: "verifier-v1",
    vaultKeyVersion: 2,
    migrateCredentialsCiphertext: async (c: string) => `${c}-migrated`,
    migrateTransactionCiphertext: async (c: string) => `${c}-migrated`,
    clearMigrationKeys,
  };
}

const oneConnection: FakeOptions = {
  rows: {
    connections: [{ id: "conn-1", encrypted_credentials: "creds-v0", encrypted_label: null }],
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

  it("migrates every row BEFORE the meta write, never after", async () => {
    const { client, calls } = makeFakeClient({
      rows: {
        connections: [{ id: "conn-1", encrypted_credentials: "creds-v0", encrypted_label: null }],
        encrypted_transactions: [{ id: "txn-1", encrypted_payload: "payload-v0" }],
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

/**
 * The transaction re-encryption loop.
 *
 * This is the only arithmetic in vault-persist.ts: an offset, an inclusive
 * range window and two different break conditions. Nothing exercised it until
 * DEV-0285. The rest of the module is well covered, including a real mutation
 * proof, which makes it easy for the next reader to assume the whole file is
 * covered. It was not, and the gap was invisible from the outside.
 *
 * What an off-by-one here would actually cost: a loop that failed to advance
 * would re-read rows it had already migrated and re-encrypt them under the new
 * MEK a second time, leaving them unreadable, with nothing red anywhere.
 *
 * These tests do not touch the loop. They pin its current behaviour so that any
 * later change to it has something to fail against.
 */
describe("vault recovery: the transaction paging loop", () => {
  function txnRows(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: `txn-${i}`,
      encrypted_payload: `payload-${i}`,
    }));
  }

  const txnSelects = (calls: RecordedCall[]) =>
    calls.filter((c) => c.table === "encrypted_transactions" && c.op === "select");

  const txnUpdates = (calls: RecordedCall[]) =>
    calls.filter((c) => c.table === "encrypted_transactions" && c.op === "update");

  const rangeOf = (call: RecordedCall) =>
    call.filters.find((f) => f.column === "range")?.value;

  const idOf = (call: RecordedCall) =>
    call.filters.find((f) => f.column === "id")?.value as string;

  it("terminates on a full page followed by an empty page", async () => {
    // Exactly one page. The first read fills the page, so the loop cannot stop
    // on the short-page break: it has to come back, get nothing, and stop on
    // the empty break instead.
    const { client, calls } = makeFakeClient({
      rows: { encrypted_transactions: txnRows(TRANSACTION_PAGE_SIZE) },
    });

    await migrateAndPersistRotatedVault(rotateArgs(client, vi.fn()));

    expect(txnSelects(calls).length).toBe(2);
    expect(txnUpdates(calls).length).toBe(TRANSACTION_PAGE_SIZE);
  });

  it("terminates on a full page followed by a short page", async () => {
    const { client, calls } = makeFakeClient({
      rows: { encrypted_transactions: txnRows(TRANSACTION_PAGE_SIZE + 3) },
    });

    await migrateAndPersistRotatedVault(rotateArgs(client, vi.fn()));

    // Two reads and no third: a short page ends the loop where it is.
    expect(txnSelects(calls).length).toBe(2);
    expect(txnUpdates(calls).length).toBe(TRANSACTION_PAGE_SIZE + 3);
  });

  it("asks for the second window starting at one page size, not the first again", async () => {
    const { client, calls } = makeFakeClient({
      rows: { encrypted_transactions: txnRows(TRANSACTION_PAGE_SIZE + 3) },
    });

    await migrateAndPersistRotatedVault(rotateArgs(client, vi.fn()));

    expect(txnSelects(calls).map(rangeOf)).toEqual([
      [0, TRANSACTION_PAGE_SIZE - 1],
      [TRANSACTION_PAGE_SIZE, TRANSACTION_PAGE_SIZE * 2 - 1],
    ]);
  });

  it("re-encrypts every row across both pages exactly once, each with its own payload", async () => {
    const total = TRANSACTION_PAGE_SIZE + 3;
    const { client, calls } = makeFakeClient({
      rows: { encrypted_transactions: txnRows(total) },
    });

    await migrateAndPersistRotatedVault(rotateArgs(client, vi.fn()));

    const updates = txnUpdates(calls);
    const timesTouched: Record<string, number> = {};
    for (const update of updates) {
      const id = idOf(update);
      timesTouched[id] = (timesTouched[id] ?? 0) + 1;
    }

    // No row skipped at the page boundary, and no row migrated twice. A row
    // migrated twice would be encrypted under the new MEK on top of itself and
    // would never open again.
    expect(updates.length).toBe(total);
    expect(Object.keys(timesTouched).length).toBe(total);
    for (const id of Object.keys(timesTouched)) expect(timesTouched[id]).toBe(1);

    // And each row carries its OWN migrated payload, not a neighbour's.
    for (const update of updates) {
      const index = Number(idOf(update).slice("txn-".length));
      expect(update.values).toEqual({ encrypted_payload: `payload-${index}-migrated` });
    }
  });

  it("writes the rotated meta only after the whole paged migration", async () => {
    const { client, calls } = makeFakeClient({
      rows: { encrypted_transactions: txnRows(TRANSACTION_PAGE_SIZE + 3) },
    });

    await migrateAndPersistRotatedVault(rotateArgs(client, vi.fn()));

    const metaIndex = calls.findIndex((c) => c.table === "user_vault_meta" && c.op === "update");
    expect(metaIndex).toBeGreaterThan(-1);
    calls.forEach((call, i) => {
      if (call.table === "encrypted_transactions") expect(i).toBeLessThan(metaIndex);
    });
  });
});
