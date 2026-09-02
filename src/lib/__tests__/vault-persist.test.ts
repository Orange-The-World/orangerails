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
  rowCountMismatchMessage,
  rowCountUnreadableMessage,
  rowNotWrittenMessage,
  CONNECTION_PAGE_SIZE,
  TRANSACTION_PAGE_SIZE,
  COUNT_READ_ATTEMPTS,
  type VaultPersistClient,
} from "../vault-persist";

type QueryResult = { data: unknown[] | null; count?: number | null; error: unknown };

interface RecordedCall {
  table: string;
  op: "select" | "update" | "count";
  /** columns passed to .select(), which is what makes the row count readable */
  columns?: string;
  /** count mode asked for on a head request, e.g. "exact" */
  countMode?: string;
  head?: boolean;
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
  /**
   * What a head count on a table returns, instead of the backing store's real
   * length. Lets a test model a count that came back null or errored, which the
   * reconciliation has to treat as a failure rather than a pass.
   */
  countResult?: Record<string, QueryResult>;
  /**
   * Count results handed back in order, one per read, before falling through to
   * the backing store's real length. countResult on its own can only model a
   * count that fails identically for ever, which is the one case where giving
   * up is right. A TRANSIENT failure is the dangerous one, because the count is
   * read at the instant when throwing costs the user their vault, and it cannot
   * be expressed without a queue.
   */
  countSequence?: Record<string, QueryResult[]>;
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

      // Honour .order(column). A query that asked for an order gets a
      // deterministic view. One that did not gets the store in whatever
      // physical order it currently holds, which is exactly the latitude the
      // real database has, and is what lets the reordering tests below fail.
      const orderFilter = call.filters.find((f) => f.column === "order");
      const view = stored.slice();
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
    // A row update returns the rows it changed. The default models an update
    // that matched the row it filtered on, because that is the only outcome
    // which proves the re-encrypted ciphertext was written. The previous
    // default, an empty array, is the shape of an update that matched NOTHING,
    // so every test here passed against a client that wrote no rows at all.
    // A test that wants that outcome now has to ask for it, with otherUpdate.
    if (options.otherUpdate) return options.otherUpdate;
    const idFilter = call.filters.find((f) => f.column === "id");
    return { data: idFilter ? [{ id: idFilter.value }] : [], error: null };
  }

  // A head request with an exact count returns a count and no rows. PostgREST
  // computes it separately from the rows, so it is the true total rather than
  // whatever a capped read happened to return, which is the property the
  // reconciliation depends on.
  function countResultFor(call: RecordedCall): QueryResult {
    const queued = options.countSequence?.[call.table];
    if (queued && queued.length > 0) return queued.shift() as QueryResult;
    const override = options.countResult?.[call.table];
    if (override) return override;
    return { data: null, count: (store[call.table] ?? []).length, error: null };
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
        select(columns: string, selectOptions?: { count?: string; head?: boolean }) {
          // Recorded under its own op on purpose. A head count is not a page
          // read, and folding it in would quietly change what the paging tests
          // above are counting.
          if (selectOptions?.head) {
            const countCall: RecordedCall = {
              table,
              op: "count",
              columns,
              countMode: selectOptions.count,
              head: true,
              filters: [],
            };
            calls.push(countCall);
            return Promise.resolve(countResultFor(countCall));
          }
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

describe("vault recovery: reconciling the row counts before the meta write", () => {
  it("stops before the meta write when the table gains a row after the page was read", async () => {
    // The concurrent insert. During a recovery this is not exotic: a sync in a
    // second tab writes rows, and any row written before the meta write is
    // written under the OLD MEK by construction. The loop ends on a short page
    // with no error anywhere, so without the reconciliation the meta write
    // lands and that row is stranded under a key nothing stores any more.
    // Keyset pagination on id would NOT catch this: a row inserted below the
    // cursor is missed exactly the same way.
    const clearMigrationKeys = vi.fn();
    const { client, calls } = makeFakeClient({
      rows: {
        connections: [
          { id: "conn-1", encrypted_credentials: "creds-1", encrypted_label: null },
          { id: "conn-2", encrypted_credentials: "creds-2", encrypted_label: null },
        ],
      },
      reorderAfterSelect: {
        connections: (rows) =>
          rows.length === 2
            ? [...rows, { id: "conn-3", encrypted_credentials: "creds-3", encrypted_label: null }]
            : rows,
      },
    });

    await expect(
      migrateAndPersistRotatedVault(rotateArgs(client, clearMigrationKeys)),
    ).rejects.toThrow(rowCountMismatchMessage("connections", 2, 3));

    // Before the meta write is the whole point: up to here the stored wrappers
    // still hold the old MEK, so stopping costs nothing irreversible.
    expect(calls.some((c) => c.table === "user_vault_meta" && c.op === "update")).toBe(false);
    expect(clearMigrationKeys).not.toHaveBeenCalled();
  });

  it("stops before the meta write when a transaction row is added under the loop", async () => {
    const clearMigrationKeys = vi.fn();
    const { client, calls } = makeFakeClient({
      rows: { encrypted_transactions: [{ id: "txn-1", encrypted_payload: "payload-1" }] },
      reorderAfterSelect: {
        encrypted_transactions: (rows) =>
          rows.length === 1 ? [...rows, { id: "txn-2", encrypted_payload: "payload-2" }] : rows,
      },
    });

    await expect(
      migrateAndPersistRotatedVault(rotateArgs(client, clearMigrationKeys)),
    ).rejects.toThrow(rowCountMismatchMessage("encrypted_transactions", 1, 2));

    expect(calls.some((c) => c.table === "user_vault_meta" && c.op === "update")).toBe(false);
    expect(clearMigrationKeys).not.toHaveBeenCalled();
  });

  it("treats a count that cannot be read as a failure, not a pass", async () => {
    // Absence of evidence is not evidence of absence. A run that could not
    // check must not be indistinguishable from a run that checked and matched.
    const clearMigrationKeys = vi.fn();
    const { client, calls } = makeFakeClient({
      ...oneConnection,
      countResult: { connections: { data: null, count: null, error: null } },
    });

    await expect(
      migrateAndPersistRotatedVault({
        ...rotateArgs(client, clearMigrationKeys),
        sleep: async () => {},
      }),
    ).rejects.toThrow(rowCountUnreadableMessage("connections"));

    expect(calls.some((c) => c.table === "user_vault_meta" && c.op === "update")).toBe(false);
    expect(clearMigrationKeys).not.toHaveBeenCalled();
  });

  it("stops when the count itself returns an error", async () => {
    const clearMigrationKeys = vi.fn();
    const { client, calls } = makeFakeClient({
      ...oneConnection,
      countResult: {
        connections: { data: null, count: null, error: { message: "count failed" } },
      },
    });

    await expect(
      migrateAndPersistRotatedVault({
        ...rotateArgs(client, clearMigrationKeys),
        sleep: async () => {},
      }),
    ).rejects.toBeTruthy();

    expect(calls.some((c) => c.table === "user_vault_meta" && c.op === "update")).toBe(false);
    expect(clearMigrationKeys).not.toHaveBeenCalled();
  });

  it("stops before the meta write when a connection update changes no row", async () => {
    // The failure a row count on its own cannot see. An update that matches
    // nothing raises no error, so a counter incremented on the absence of an
    // error reaches the same number as the table count, and the reconciliation
    // certifies a run in which not one ciphertext actually moved.
    const clearMigrationKeys = vi.fn();
    const { client, calls } = makeFakeClient({
      ...oneConnection,
      otherUpdate: { data: [], error: null },
    });

    await expect(
      migrateAndPersistRotatedVault(rotateArgs(client, clearMigrationKeys)),
    ).rejects.toThrow(rowNotWrittenMessage("connections", "conn-1"));

    expect(calls.some((c) => c.table === "user_vault_meta" && c.op === "update")).toBe(false);
    expect(clearMigrationKeys).not.toHaveBeenCalled();
  });

  it("stops before the meta write when a transaction update changes no row", async () => {
    const clearMigrationKeys = vi.fn();
    const { client, calls } = makeFakeClient({
      rows: { encrypted_transactions: [{ id: "txn-1", encrypted_payload: "payload-1" }] },
      otherUpdate: { data: [], error: null },
    });

    await expect(
      migrateAndPersistRotatedVault(rotateArgs(client, clearMigrationKeys)),
    ).rejects.toThrow(rowNotWrittenMessage("encrypted_transactions", "txn-1"));

    expect(calls.some((c) => c.table === "user_vault_meta" && c.op === "update")).toBe(false);
    expect(clearMigrationKeys).not.toHaveBeenCalled();
  });

  it("asks every row update for the row it changed, not only for the absence of an error", async () => {
    const { client, calls } = makeFakeClient({
      rows: {
        connections: [{ id: "conn-1", encrypted_credentials: "creds-v0", encrypted_label: null }],
        encrypted_transactions: [{ id: "txn-1", encrypted_payload: "payload-v0" }],
      },
    });

    await migrateAndPersistRotatedVault(rotateArgs(client, vi.fn()));

    const rowUpdates = calls.filter((c) => c.op === "update" && c.table !== "user_vault_meta");
    expect(rowUpdates.length).toBe(2);
    for (const call of rowUpdates) expect(call.columns).toBe("id");
  });

  it("names the row that was not written, so support has something to act on", () => {
    expect(rowNotWrittenMessage("connections", "conn-9")).toContain("connections row conn-9");
  });

  it("names both numbers, so a run that reconciled nothing does not read as a clean one", () => {
    expect(rowCountMismatchMessage("connections", 0, 900)).toContain("migrated 0 of 900");
    expect(rowCountMismatchMessage("connections", 900, 900)).toContain("migrated 900 of 900");
  });

  it("counts both tables exactly, and does it before the meta write", async () => {
    const { client, calls } = makeFakeClient({
      rows: {
        connections: [{ id: "conn-1", encrypted_credentials: "creds-v0", encrypted_label: null }],
        encrypted_transactions: [{ id: "txn-1", encrypted_payload: "payload-v0" }],
      },
    });

    await migrateAndPersistRotatedVault(rotateArgs(client, vi.fn()));

    const countCalls = calls.filter((c) => c.op === "count");
    expect(countCalls.map((c) => c.table)).toEqual(["connections", "encrypted_transactions"]);

    // An estimated count would not be evidence of anything, and a head request
    // is what keeps the count itself out of reach of the server row cap that is
    // one of the two failures being guarded against.
    for (const call of countCalls) {
      expect(call.countMode).toBe("exact");
      expect(call.head).toBe(true);
    }

    const metaIndex = calls.findIndex((c) => c.table === "user_vault_meta" && c.op === "update");
    for (const call of countCalls) expect(calls.indexOf(call)).toBeLessThan(metaIndex);
  });

  it("retries a count that fails once, so a flaky read cannot strand a vault", async () => {
    // The regression the retry exists to stop. The count runs after every
    // ciphertext has been rewritten and before the meta write, so at that
    // instant the only copy of the new MEK is in the page. Throwing on the
    // first 502 turns a transient network error into permanent key loss for a
    // user who then reloads, and before the reconciliation existed this
    // recovery would simply have completed. The read is pure and idempotent.
    const clearMigrationKeys = vi.fn();
    const { client, calls } = makeFakeClient({
      ...oneConnection,
      countSequence: {
        connections: [{ data: null, count: null, error: { message: "502 bad gateway" } }],
      },
    });

    await migrateAndPersistRotatedVault({
      ...rotateArgs(client, clearMigrationKeys),
      sleep: async () => {},
    });

    const countCalls = calls.filter((c) => c.op === "count" && c.table === "connections");
    expect(countCalls.length).toBe(2);
    expect(calls.some((c) => c.table === "user_vault_meta" && c.op === "update")).toBe(true);
    expect(clearMigrationKeys).toHaveBeenCalledTimes(1);
  });

  it("gives up once the retries are exhausted, and still stops before the meta write", async () => {
    // The other half of the same change. Retrying must not turn "I could not
    // check" into a pass: a count that fails every time is a real failure.
    const clearMigrationKeys = vi.fn();
    const { client, calls } = makeFakeClient({
      ...oneConnection,
      countResult: { connections: { data: null, count: null, error: { message: "still down" } } },
    });

    await expect(
      migrateAndPersistRotatedVault({
        ...rotateArgs(client, clearMigrationKeys),
        sleep: async () => {},
      }),
    ).rejects.toThrow(rowCountUnreadableMessage("connections"));

    expect(calls.filter((c) => c.op === "count").length).toBe(COUNT_READ_ATTEMPTS);
    expect(calls.some((c) => c.table === "user_vault_meta" && c.op === "update")).toBe(false);
    expect(clearMigrationKeys).not.toHaveBeenCalled();
  });

  it("issues no further transaction update once one row in the page has failed", async () => {
    // The page used to be a Promise.all over up to 500 concurrent updates. On a
    // mid-page rejection the other in-flight updates kept running and kept
    // WRITING after this function had already thrown, which is the one thing a
    // fail-closed path must not do. Put the Promise.all back and this goes red.
    const clearMigrationKeys = vi.fn();
    const { client, calls } = makeFakeClient({
      rows: {
        encrypted_transactions: [
          { id: "txn-1", encrypted_payload: "payload-1" },
          { id: "txn-2", encrypted_payload: "payload-2" },
          { id: "txn-3", encrypted_payload: "payload-3" },
        ],
      },
    });
    let seen = 0;
    const args = {
      ...rotateArgs(client, clearMigrationKeys),
      migrateTransactionCiphertext: async (c: string) => {
        seen += 1;
        if (seen === 2) throw new Error("decrypt failed");
        return `${c}-migrated`;
      },
    };

    await expect(migrateAndPersistRotatedVault(args)).rejects.toThrow("decrypt failed");

    const txnUpdates = calls.filter(
      (c) => c.table === "encrypted_transactions" && c.op === "update",
    );
    expect(txnUpdates.length).toBe(1);
    expect(txnUpdates[0].filters).toContainEqual({ column: "id", value: "txn-1" });
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
