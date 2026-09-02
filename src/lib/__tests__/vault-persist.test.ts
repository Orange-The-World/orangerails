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
  SEAL_CHECK_FAILED_MESSAGE,
  VAULT_OWN_SEAL,
  type VaultPersistClient,
} from "../vault-persist";

type QueryResult = { data: unknown[] | null; error: unknown; count?: number | null };

interface RecordedCall {
  table: string;
  op: "select" | "update";
  /** columns passed to .select(), which is what makes the row count readable */
  columns?: string;
  values?: Record<string, unknown>;
  /** options passed to .select(), which is how a head count is recognised */
  options?: { count?: string; head?: boolean };
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
  neq(column: string, value: unknown): SelectChain;
  range(from: number, to: number): Promise<QueryResult>;
}

/**
 * The paged reads on a table, excluding the reconciliation head count.
 *
 * The head count is a select too, so without this the assertions below about
 * how many times the loop read a table would silently start counting it.
 */
function pagedSelects(calls: RecordedCall[], table: string) {
  return calls.filter((c) => c.table === table && c.op === "select" && !c.options?.head);
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
   * What a head count returns instead of the store size. Only for the cases
   * where the count itself is the thing under test.
   */
  countResult?: Record<string, { count?: number | null; error?: unknown }>;
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
      const stored = store[call.table] ?? [];

      // A head request with an exact count is the reconciliation read. It
      // returns no rows: the count IS the answer, and it is deliberately not
      // derived from any page above, because the whole point of it is to
      // measure the table with a different ruler than the paged read used.
      if (call.options?.head) {
        const forced = options.countResult?.[call.table];
        if (forced) return { data: null, error: forced.error ?? null, count: forced.count ?? null };

        // Honour .neq(column, value), which is how the seal check narrows the
        // count to rows this rotation could not open.
        //
        // A fixture row that does not mention the column counts as MATCHING
        // the value, not as differing from it. That is faithful rather than
        // lenient: sealed_under is NOT NULL DEFAULT 'ort' in the schema, so a
        // row that says nothing about its seal is a row that took the default.
        const neqFilters = call.filters.filter((f) => f.column.startsWith("neq:"));
        const counted = stored.filter((row) =>
          neqFilters.every((f) => {
            const held = (row as Record<string, unknown>)[f.column.slice(4)];
            return held !== undefined && held !== f.value;
          }),
        );
        return { data: null, error: null, count: counted.length };
      }

      const override = options.selectResult?.[call.table];
      if (override) return override;

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
        select(columns: string, selectOptions?: { count?: string; head?: boolean }) {
          const call: RecordedCall = {
            table,
            op: "select",
            columns,
            options: selectOptions,
            filters: [],
          };
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
            neq(column: string, value: unknown) {
              call.filters.push({ column: `neq:${column}`, value });
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

    // One full page plus one short page is what ends the loop; two paged
    // reads is the direct evidence the cursor actually advanced.
    expect(pagedSelects(calls, "encrypted_transactions").length).toBe(2);
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

    // One full page plus one short page. Two paged reads is the direct evidence
    // the cursor advanced rather than the read being trusted to return
    // everything.
    expect(pagedSelects(calls, "connections").length).toBe(2);
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
    for (const call of pagedSelects(calls, "connections")) {
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
    for (const call of pagedSelects(calls, "encrypted_transactions")) {
      expect(call.filters).toContainEqual({ column: "order", value: ["id", true] });
    }
  });
});

describe("vault recovery: reconciling the row counts before the meta write", () => {
  function metaUpdates(calls: RecordedCall[]) {
    return calls.filter((c) => c.table === "user_vault_meta" && c.op === "update");
  }

  it("throws BEFORE the meta write when the store gains a row after the page was read", async () => {
    // A sync running in a second tab inserts an encrypted_transactions row
    // while the rotation is in flight. It is written under the OLD MEK by
    // construction, the loop has already read past it, and before this check
    // existed the meta write still landed: that row was then wrapped under a
    // key nothing stores any more, permanently and with nothing raised.
    //
    // Take the reconciliation out of vault-persist.ts and this test passes
    // again. That is the only reason to trust it. Every defect found on this
    // path so far was a check that could not go red.
    const clearMigrationKeys = vi.fn();
    let inserted = false;
    const { client, calls } = makeFakeClient({
      rows: {
        encrypted_transactions: [
          { id: "txn-1", encrypted_payload: "payload-1" },
          { id: "txn-2", encrypted_payload: "payload-2" },
        ],
      },
      reorderAfterSelect: {
        encrypted_transactions: (rows) => {
          if (inserted) return rows;
          inserted = true;
          return [...rows, { id: "txn-3", encrypted_payload: "payload-3" }];
        },
      },
    });

    await expect(
      migrateAndPersistRotatedVault(rotateArgs(client, clearMigrationKeys)),
    ).rejects.toThrow("migrated 2 of 3 transactions");

    // Both halves matter. No meta write means the stored wrappers still hold
    // the old MEK, so the rows that did not move still read; not clearing the
    // migration keys means this session can still read the ones that did.
    expect(metaUpdates(calls).length).toBe(0);
    expect(clearMigrationKeys).not.toHaveBeenCalled();
  });

  it("treats a count that cannot be read as a failure, not as agreement", async () => {
    const clearMigrationKeys = vi.fn();
    const { client, calls } = makeFakeClient({
      ...oneConnection,
      countResult: { connections: { count: null } },
    });

    await expect(
      migrateAndPersistRotatedVault(rotateArgs(client, clearMigrationKeys)),
    ).rejects.toThrow("migrated 1 of unknown connections");

    expect(metaUpdates(calls).length).toBe(0);
    expect(clearMigrationKeys).not.toHaveBeenCalled();
  });

  it("stops the rotation when the count read itself errors", async () => {
    const clearMigrationKeys = vi.fn();
    const { client, calls } = makeFakeClient({
      ...oneConnection,
      countResult: { connections: { count: null, error: { message: "count boom" } } },
    });

    await expect(
      migrateAndPersistRotatedVault(rotateArgs(client, clearMigrationKeys)),
    ).rejects.toBeTruthy();

    expect(metaUpdates(calls).length).toBe(0);
    expect(clearMigrationKeys).not.toHaveBeenCalled();
  });

  it("counts both tables with an exact head request, before the meta write", async () => {
    // An estimate would be worthless here, and counting the rows the paged
    // read returned would measure the fault with the ruler that has the fault
    // in it. Assert the shape of the read, not just that some read happened.
    const { client, calls } = makeFakeClient({
      rows: {
        connections: [{ id: "conn-1", encrypted_credentials: "creds-v0", encrypted_label: null }],
        encrypted_transactions: [{ id: "txn-1", encrypted_payload: "payload-v0" }],
      },
    });

    await migrateAndPersistRotatedVault(rotateArgs(client, vi.fn()));

    const metaIndex = calls.findIndex((c) => c.table === "user_vault_meta" && c.op === "update");
    expect(metaIndex).toBeGreaterThan(-1);

    for (const table of ["connections", "encrypted_transactions"]) {
      const isHeadCount = (c: RecordedCall) =>
        c.table === table && c.op === "select" && c.options?.head === true;
      const index = calls.findIndex(isHeadCount);
      expect(index).toBeGreaterThan(-1);
      expect(index).toBeLessThan(metaIndex);
      expect(calls.find(isHeadCount)?.options).toEqual({ count: "exact", head: true });
    }
  });
});

describe("vault recovery: refusing ciphertext the rotation cannot open", () => {
  const mixedSeals = {
    rows: {
      connections: [{ id: "conn-1", encrypted_credentials: "creds-v0", encrypted_label: null }],
      encrypted_transactions: [
        { id: "txn-1", encrypted_payload: "payload-1", sealed_under: "ort" },
        { id: "txn-2", encrypted_payload: "payload-2", sealed_under: "opk" },
      ],
    },
  };

  it("refuses a mixed-seal table and rewrites NOTHING", async () => {
    // txn-2 was sealed by a background writer to the subaccount's public
    // delivery key. Only the browser's private key opens it; the MEK never
    // does. Without this guard the loop hands it to migrateTransactionCiphertext
    // and the throw arrives from inside the crypto, after txn-1 and every
    // connection have already been rewritten under a MEK that is not stored
    // anywhere yet, in a state the source documents as not retryable.
    //
    // "It throws" is therefore not the property under test. "Nothing moved" is.
    const clearMigrationKeys = vi.fn();
    const { client, calls } = makeFakeClient(mixedSeals);

    await expect(
      migrateAndPersistRotatedVault(rotateArgs(client, clearMigrationKeys)),
    ).rejects.toThrow("1 of your transactions");

    // Every table, not just the transactions: the connections loop runs first,
    // so a guard placed one line too low would leave those rewritten.
    expect(calls.filter((c) => c.op === "update")).toEqual([]);
    expect(clearMigrationKeys).not.toHaveBeenCalled();
  });

  it("stops before anything moves when the seal check cannot be read", async () => {
    const clearMigrationKeys = vi.fn();
    const { client, calls } = makeFakeClient({
      ...mixedSeals,
      countResult: { encrypted_transactions: { count: null } },
    });

    await expect(
      migrateAndPersistRotatedVault(rotateArgs(client, clearMigrationKeys)),
    ).rejects.toThrow(SEAL_CHECK_FAILED_MESSAGE);

    expect(calls.filter((c) => c.op === "update")).toEqual([]);
    expect(clearMigrationKeys).not.toHaveBeenCalled();
  });

  it("proceeds normally when every transaction carries the vault's own seal", async () => {
    // The guard has to let the ordinary case through, or it is just an outage.
    const clearMigrationKeys = vi.fn();
    const { client, calls } = makeFakeClient({
      rows: {
        connections: [{ id: "conn-1", encrypted_credentials: "creds-v0", encrypted_label: null }],
        encrypted_transactions: [
          { id: "txn-1", encrypted_payload: "payload-1", sealed_under: VAULT_OWN_SEAL },
          { id: "txn-2", encrypted_payload: "payload-2", sealed_under: VAULT_OWN_SEAL },
        ],
      },
    });

    await migrateAndPersistRotatedVault(rotateArgs(client, clearMigrationKeys));

    expect(calls.filter((c) => c.table === "encrypted_transactions" && c.op === "update").length)
      .toBe(2);
    expect(clearMigrationKeys).toHaveBeenCalledTimes(1);
  });

  it("asks the seal question before the first read of any row", async () => {
    // Ordering is the whole guarantee. Assert it directly rather than inferring
    // it from the fact that the happy path happened to pass.
    const { client, calls } = makeFakeClient({
      rows: {
        connections: [{ id: "conn-1", encrypted_credentials: "creds-v0", encrypted_label: null }],
      },
    });

    await migrateAndPersistRotatedVault(rotateArgs(client, vi.fn()));

    const sealCheck = calls.findIndex((c) =>
      c.filters.some((f) => f.column === "neq:sealed_under" && f.value === VAULT_OWN_SEAL),
    );
    expect(sealCheck).toBe(0);
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
