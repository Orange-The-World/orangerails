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
  CONNECTION_PAGE_SIZE,
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

interface SelectChain {
  then(
    onFulfilled: (value: QueryResult) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ): Promise<unknown>;
  order(column: string, options?: { ascending?: boolean }): SelectChain;
  range(from: number, to: number): Promise<QueryResult>;
  eq(column: string, value: unknown): SelectChain;
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
  /**
   * Rewrites a table's backing rows immediately AFTER each select on it, so a
   * test can model the physical row order changing between pages. The real
   * database is free to do exactly that: the updates issued inside the paging
   * loop write new tuple versions, and a scan with no ORDER BY may return them
   * in a different order next time.
   */
  reorderAfterSelect?: Record<string, (rows: unknown[]) => unknown[]>;
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

  // The backing store. It is a copy, because reorderAfterSelect rewrites it and
  // a test's fixture must not be mutated underneath it.
  const store: Record<string, unknown[]> = {};
  for (const [table, rows] of Object.entries(options.rows ?? {})) store[table] = rows.slice();

  function resultFor(call: RecordedCall): QueryResult {
    if (call.op === "select") {
      const override = options.selectResult?.[call.table];
      if (override) return override;
      const stored = store[call.table] ?? [];

      // Honour .eq(column, value). Any filter that is not the special
      // "order" or "range" marker is an equality filter on the stored rows,
      // the same as a real .eq() call would apply.
      const eqFilters = call.filters.filter((f) => f.column !== "order" && f.column !== "range");
      const filtered = eqFilters.length
        ? stored.filter((row) =>
            eqFilters.every((f) => (row as Record<string, unknown>)[f.column] === f.value),
          )
        : stored;

      // Honour .order(column). A query that asked for an order gets a
      // deterministic view. One that did not gets the store in whatever
      // physical order it currently holds, which is exactly the latitude the
      // real database has, and is what lets the reordering tests below fail.
      const orderFilter = call.filters.find((f) => f.column === "order");
      const view = filtered.slice();
      if (orderFilter) {
        const [column, ascending] = orderFilter.value as [string, boolean];
        view.sort((a, b) => {
          const left = String((a as Record<string, unknown>)[column]);
          const right = String((b as Record<string, unknown>)[column]);
          if (left === right) return 0;
          const ahead = left < right ? -1 : 1;
          return ascending ? ahead : -ahead;
        });
      }

      // Honour .range(from, to). A fake that always returns the same page
      // regardless of its arguments can never exercise pagination, and a
      // fixture of TRANSACTION_PAGE_SIZE or more rows would loop forever
      // against it instead of failing loudly (see the paging test below).
      const rangeFilter = call.filters.find((f) => f.column === "range");
      const page = rangeFilter
        ? view.slice(
            (rangeFilter.value as [number, number])[0],
            (rangeFilter.value as [number, number])[1] + 1,
          )
        : view;

      const reorder = options.reorderAfterSelect?.[call.table];
      if (reorder) store[call.table] = reorder(stored.slice());

      return { data: page, error: null };
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
            order(column: string, orderOptions?: { ascending?: boolean }) {
              call.filters.push({
                column: "order",
                value: [column, orderOptions?.ascending !== false],
              });
              return chain;
            },
            range(from: number, to: number) {
              call.filters.push({ column: "range", value: [from, to] });
              return Promise.resolve(resultFor(call));
            },
            eq(column: string, value: unknown) {
              call.filters.push({ column, value });
              return chain;
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

function rotateArgs(client: VaultPersistClient, clearMigrationKeys: () => void) {
  return {
    supabase: client,
    userId: "user-1",
    priorRecoveryCiphertext: "recovery-ciphertext-v0",
    newEncMekCiphertext: "enc-mek-v1",
    newRecoveryCiphertext: "recovery-ciphertext-v1",
    newVerifierCiphertext: "verifier-v1",
    vaultKeyVersion: 2,
    // Null is the ordinary case: a vault with no PQC keys yet. The tests that
    // assert the meta write matches the four columns exactly are what prove
    // these are not sent as null, which would overwrite real ciphertext.
    newKemSecretWrapped: null as string | null,
    newSigSecretWrapped: null as string | null,
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

    // Both public keys are cleared in this payload because the default args
    // carry neither secret. That is the invariant, not an over-write; the test
    // below spells out why it is correct even when another session created a
    // keypair a moment ago.
    const metaUpdate = calls.find((c) => c.table === "user_vault_meta" && c.op === "update");
    expect(metaUpdate?.values).toEqual({
      enc_mek_ciphertext: "enc-mek-v1",
      recovery_ciphertext: "recovery-ciphertext-v1",
      vault_verifier_ciphertext: "verifier-v1",
      vault_key_version: 2,
      kem_public_key: null,
      sig_public_key: null,
    });
  });

  it("carries the re-wrapped PQC secrets in the SAME statement as the wrappers", async () => {
    const { client, calls } = makeFakeClient(oneConnection);

    await migrateAndPersistRotatedVault({
      ...rotateArgs(client, vi.fn()),
      newKemSecretWrapped: "kem-wrapped-v1",
      newSigSecretWrapped: "sig-wrapped-v1",
    });

    // One statement, not two. A second write would leave a window in which the
    // wrappers have rotated and the PQC secrets are still under the old MEK,
    // and anything that interrupted that window would orphan them for good.
    const metaUpdates = calls.filter((c) => c.table === "user_vault_meta" && c.op === "update");
    expect(metaUpdates.length).toBe(1);
    expect(metaUpdates[0]?.values).toEqual({
      enc_mek_ciphertext: "enc-mek-v1",
      recovery_ciphertext: "recovery-ciphertext-v1",
      vault_verifier_ciphertext: "verifier-v1",
      vault_key_version: 2,
      kem_secret_wrapped: "kem-wrapped-v1",
      sig_secret_wrapped: "sig-wrapped-v1",
    });

    // The regression guard on the healthy path. Both secrets travelled, so
    // NEITHER public key may be touched. A change that starts clearing keys on
    // a recovery that worked fails here first, and that failure is the one that
    // matters most: it would destroy live keypairs.
    const columns = Object.keys(metaUpdates[0]?.values ?? {});
    expect(columns).not.toContain("kem_public_key");
    expect(columns).not.toContain("sig_public_key");
  });

  it("never writes null over a stored PQC secret", async () => {
    const { client, calls } = makeFakeClient(oneConnection);

    // Only one of the two is present, which is the shape that catches a naive
    // spread: the absent one must be left out of the statement entirely rather
    // than sent as null and clearing a column that may hold real ciphertext.
    await migrateAndPersistRotatedVault({
      ...rotateArgs(client, vi.fn()),
      newKemSecretWrapped: "kem-wrapped-v1",
      newSigSecretWrapped: null,
    });

    const metaUpdate = calls.find((c) => c.table === "user_vault_meta" && c.op === "update");
    expect(metaUpdate?.values).toEqual({
      enc_mek_ciphertext: "enc-mek-v1",
      recovery_ciphertext: "recovery-ciphertext-v1",
      vault_verifier_ciphertext: "verifier-v1",
      vault_key_version: 2,
      kem_secret_wrapped: "kem-wrapped-v1",
      sig_public_key: null,
    });
    expect(Object.keys(metaUpdate?.values ?? {})).not.toContain("sig_secret_wrapped");

    // The sig PUBLIC key is cleared instead, and the kem one is left alone.
    // Leaving a public key behind is what makes the loss permanent:
    // ensurePqcKeypairs short-circuits on a populated public key and never
    // regenerates, so the row would keep a public key whose secret is wrapped
    // under a MEK that no longer exists.
    expect(Object.keys(metaUpdate?.values ?? {})).not.toContain("kem_public_key");
  });

  it("clears the kem public key when only the sig secret was carried", async () => {
    // The mirror of the test above. An implementation that clears one side and
    // forgets the other passes a single-orientation suite and still strands
    // half the keypair, so both orientations are pinned.
    const { client, calls } = makeFakeClient(oneConnection);

    await migrateAndPersistRotatedVault({
      ...rotateArgs(client, vi.fn()),
      newKemSecretWrapped: null,
      newSigSecretWrapped: "sig-wrapped-v1",
    });

    const metaUpdate = calls.find((c) => c.table === "user_vault_meta" && c.op === "update");
    expect(metaUpdate?.values).toEqual({
      enc_mek_ciphertext: "enc-mek-v1",
      recovery_ciphertext: "recovery-ciphertext-v1",
      vault_verifier_ciphertext: "verifier-v1",
      vault_key_version: 2,
      sig_secret_wrapped: "sig-wrapped-v1",
      kem_public_key: null,
    });
    expect(Object.keys(metaUpdate?.values ?? {})).not.toContain("kem_secret_wrapped");
    expect(Object.keys(metaUpdate?.values ?? {})).not.toContain("sig_public_key");
  });

  it("clears BOTH public keys in the SAME statement when neither secret was carried", async () => {
    // Two different situations arrive here and both need this. One: the stored
    // secret would not open, so that keypair is already dead. Two: the secret
    // columns were null when the recovery READ the row, and another session
    // created a keypair while the migration loop was running. The old password
    // still unlocks throughout that loop, deliberately, because meta is written
    // last, so another tab loading the app is enough to backfill a keypair under
    // the OLD MEK. The compare-and-swap does not catch it, because nothing in
    // that backfill touches recovery_ciphertext.
    //
    // So yes, this clears a public key a legitimate concurrent write may have
    // just made. That is correct: its secret is wrapped under the MEK this
    // recovery is discarding, so it is dead too, and clearing it is what lets
    // the next unlock regenerate a working pair instead of short-circuiting on a
    // corpse forever.
    const { client, calls } = makeFakeClient(oneConnection);

    await migrateAndPersistRotatedVault(rotateArgs(client, vi.fn()));

    // One statement, not two. A second write would leave a window in which the
    // wrappers have rotated and the public keys have not.
    const metaUpdates = calls.filter((c) => c.table === "user_vault_meta" && c.op === "update");
    expect(metaUpdates.length).toBe(1);
    expect(metaUpdates[0]?.values?.kem_public_key).toBeNull();
    expect(metaUpdates[0]?.values?.sig_public_key).toBeNull();

    // Same compare-and-swap and same row-count proof as before. The clear is an
    // addition to the statement, not a new write with weaker guards.
    expect(metaUpdates[0]?.filters).toContainEqual({ column: "user_id", value: "user-1" });
    expect(metaUpdates[0]?.filters).toContainEqual({
      column: "recovery_ciphertext",
      value: "recovery-ciphertext-v0",
    });
    expect(metaUpdates[0]?.columns).toBe("user_id");
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

  it("refuses before any row is re-encrypted when a kem_secret_wrapped is stored but the caller supplies null (OR-T0755)", async () => {
    const { client, calls } = makeFakeClient({
      rows: {
        user_vault_meta: [
          { user_id: "user-1", kem_secret_wrapped: "old-kem-wrapped", sig_secret_wrapped: null },
        ],
        connections: [{ id: "conn-1", encrypted_credentials: "creds-v0", encrypted_label: null }],
      },
    });

    await expect(
      migrateAndPersistRotatedVault(rotateArgs(client, vi.fn())),
    ).rejects.toThrow(/kem_secret_wrapped is stored/);

    // The whole point: refused before anything below ran, so nothing was
    // touched, not the connection rows and not the meta row.
    expect(calls.some((c) => c.op === "update")).toBe(false);
  });

  it("refuses before any row is re-encrypted when a sig_secret_wrapped is stored but the caller supplies null (OR-T0755)", async () => {
    const { client, calls } = makeFakeClient({
      rows: {
        user_vault_meta: [
          { user_id: "user-1", kem_secret_wrapped: null, sig_secret_wrapped: "old-sig-wrapped" },
        ],
        connections: [{ id: "conn-1", encrypted_credentials: "creds-v0", encrypted_label: null }],
      },
    });

    await expect(
      migrateAndPersistRotatedVault(rotateArgs(client, vi.fn())),
    ).rejects.toThrow(/sig_secret_wrapped is stored/);

    expect(calls.some((c) => c.op === "update")).toBe(false);
  });

  it("does not refuse when nothing is stored yet, the ordinary no-PQC-keys case", async () => {
    const { client } = makeFakeClient({
      rows: {
        user_vault_meta: [
          { user_id: "user-1", kem_secret_wrapped: null, sig_secret_wrapped: null },
        ],
        connections: [{ id: "conn-1", encrypted_credentials: "creds-v0", encrypted_label: null }],
      },
    });

    await expect(
      migrateAndPersistRotatedVault(rotateArgs(client, vi.fn())),
    ).resolves.toBeUndefined();
  });

  it("does not refuse when the caller genuinely carries both secrets forward", async () => {
    const { client } = makeFakeClient({
      rows: {
        user_vault_meta: [
          {
            user_id: "user-1",
            kem_secret_wrapped: "old-kem-wrapped",
            sig_secret_wrapped: "old-sig-wrapped",
          },
        ],
        connections: [{ id: "conn-1", encrypted_credentials: "creds-v0", encrypted_label: null }],
      },
    });

    await expect(
      migrateAndPersistRotatedVault({
        ...rotateArgs(client, vi.fn()),
        newKemSecretWrapped: "kem-wrapped-v1",
        newSigSecretWrapped: "sig-wrapped-v1",
      }),
    ).resolves.toBeUndefined();
  });

  it("terminates and migrates every row exactly once against a fixture bigger than one page", async () => {
    const rowCount = TRANSACTION_PAGE_SIZE + 1;
    const rows = Array.from({ length: rowCount }, (_, i) => ({
      id: `txn-${i}`,
      encrypted_payload: `payload-${i}`,
    }));
    const { client, calls } = makeFakeClient({ rows: { encrypted_transactions: rows } });

    await migrateAndPersistRotatedVault(rotateArgs(client, vi.fn()));

    const txnUpdates = calls.filter((c) => c.table === "encrypted_transactions" && c.op === "update");
    const updatedIds = txnUpdates.map((c) => c.filters.find((f) => f.column === "id")?.value);
    expect(txnUpdates.length).toBe(rowCount);
    expect(new Set(updatedIds).size).toBe(rowCount);

    // One full page plus one short page is what ends the loop; two select
    // calls is the direct evidence the cursor actually advanced.
    const selectCalls = calls.filter((c) => c.table === "encrypted_transactions" && c.op === "select");
    expect(selectCalls.length).toBe(2);
  });

  it("pages the connections read instead of trusting one capped select", async () => {
    // A single unpaged select is capped server side, and a capped read is a
    // SUCCESSFUL read: no error is raised. Every connection past the cap used to
    // stay wrapped under the old MEK while the meta write still landed, which
    // strands those rows under a key nothing stores any more.
    const rowCount = CONNECTION_PAGE_SIZE + 3;
    const rows = Array.from({ length: rowCount }, (_, i) => ({
      id: `conn-${String(i).padStart(4, "0")}`,
      encrypted_credentials: `creds-${i}`,
      encrypted_label: null,
    }));
    const { client, calls } = makeFakeClient({ rows: { connections: rows } });

    await migrateAndPersistRotatedVault(rotateArgs(client, vi.fn()));

    const updatedIds = calls
      .filter((c) => c.table === "connections" && c.op === "update")
      .map((c) => c.filters.find((f) => f.column === "id")?.value);
    expect(updatedIds.length).toBe(rowCount);
    expect(new Set(updatedIds).size).toBe(rowCount);

    // One full page plus one short page. Two selects is the direct evidence the
    // cursor advanced rather than the read being trusted to return everything.
    const selectCalls = calls.filter((c) => c.table === "connections" && c.op === "select");
    expect(selectCalls.length).toBe(2);
  });

  it("migrates every connection exactly once when the order changes between pages", async () => {
    const rowCount = CONNECTION_PAGE_SIZE + 3;
    const rows = Array.from({ length: rowCount }, (_, i) => ({
      id: `conn-${String(i).padStart(4, "0")}`,
      encrypted_credentials: `creds-${i}`,
      encrypted_label: null,
    }));
    const { client, calls } = makeFakeClient({
      rows: { connections: rows },
      reorderAfterSelect: { connections: (r) => r.slice().reverse() },
    });

    await migrateAndPersistRotatedVault(rotateArgs(client, vi.fn()));

    const updatedIds = calls
      .filter((c) => c.table === "connections" && c.op === "update")
      .map((c) => c.filters.find((f) => f.column === "id")?.value);
    expect(updatedIds.length).toBe(rowCount);
    expect(new Set(updatedIds).size).toBe(rowCount);
    for (const call of calls.filter((c) => c.table === "connections" && c.op === "select")) {
      expect(call.filters).toContainEqual({ column: "order", value: ["id", true] });
    }
  });

  it("migrates every transaction exactly once when the order changes between pages", async () => {
    // The case the fixed-array paging test above cannot reach. Postgres returns
    // no guaranteed order without ORDER BY, and the update inside the loop
    // writes a new tuple version, so the physical order can change under it.
    // Reversing the store after every select models that. Take the order clause
    // out of the source and this fails: rows are both skipped, which strands
    // them permanently, and returned twice, which throws mid-rotation.
    const rowCount = TRANSACTION_PAGE_SIZE + 5;
    const rows = Array.from({ length: rowCount }, (_, i) => ({
      id: `txn-${String(i).padStart(4, "0")}`,
      encrypted_payload: `payload-${i}`,
    }));
    const { client, calls } = makeFakeClient({
      rows: { encrypted_transactions: rows },
      reorderAfterSelect: { encrypted_transactions: (r) => r.slice().reverse() },
    });

    await migrateAndPersistRotatedVault(rotateArgs(client, vi.fn()));

    const updatedIds = calls
      .filter((c) => c.table === "encrypted_transactions" && c.op === "update")
      .map((c) => c.filters.find((f) => f.column === "id")?.value);
    expect(updatedIds.length).toBe(rowCount);
    expect(new Set(updatedIds).size).toBe(rowCount);
    for (const call of calls.filter(
      (c) => c.table === "encrypted_transactions" && c.op === "select",
    )) {
      expect(call.filters).toContainEqual({ column: "order", value: ["id", true] });
    }
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
