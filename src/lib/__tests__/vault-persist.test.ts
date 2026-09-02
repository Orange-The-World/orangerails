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
  rowNotWrittenMessage,
  PASSWORD_CHANGE_CONFLICT_MESSAGE,
  RECOVERY_META_NOT_SAVED_MESSAGE,
  GENERATION_UNREADABLE_MESSAGE,
  CONNECTION_PAGE_SIZE,
  TRANSACTION_PAGE_SIZE,
  RECONCILE_MAX_PASSES,
  DATA_KEY_GENERATION_DEFAULT,
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
  gt(column: string, value: unknown): SelectChain;
  neq(column: string, value: unknown): SelectChain;
  range(from: number, to: number): Promise<QueryResult>;
  limit(count: number): Promise<QueryResult>;
}

/**
 * The paged reads on a table, excluding the reconciliation head count.
 *
 * The head count is a select too, so without this the assertions below about
 * how many times the loop read a table would silently start counting it.
 */
function pagedSelects(calls: RecordedCall[], table: string) {
  return calls.filter(
    (c) =>
      c.table === table &&
      c.op === "select" &&
      !c.options?.head &&
      // The generation probe is a select too. It reads one row to pick this
      // rotation's marker and migrates nothing, so counting it here would make
      // every assertion about how many times a walk paged a table wrong by one.
      c.columns !== "data_key_generation",
  );
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
   * test can model another session changing the table mid-walk. The real
   * database is free to do all of it: the updates issued inside the paging loop
   * write new tuple versions, so a scan may return rows in a different order
   * next time, and a second tab can INSERT or DELETE rows while the rotation is
   * running. Returning a reordered, longer or shorter array models each of
   * those. Head count reads deliberately do NOT trigger this, so a test can
   * hold the store still while the count is taken.
   */
  reorderAfterSelect?: Record<
    string,
    (rows: unknown[], store: Record<string, unknown[]>) => unknown[]
  >;
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
  //
  // Rows enter it through withDefaults, which is what models the column
  // default: a fixture written without data_key_generation reads back as
  // generation 1, because that is what the database puts there when nobody
  // sets it. Without this a marker read would answer undefined, which is a
  // state the real table cannot be in (the column is NOT NULL).
  const withDefaults = (rows: unknown[]): unknown[] =>
    rows.map((row) => {
      const record = row as Record<string, unknown>;
      return record.data_key_generation === undefined
        ? { ...record, data_key_generation: DATA_KEY_GENERATION_DEFAULT }
        : record;
    });

  const store: Record<string, unknown[]> = {};
  for (const [table, rows] of Object.entries(options.rows ?? {})) {
    store[table] = withDefaults(rows);
  }

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

        // A count can carry a filter, and the completeness read uses one: how
        // many rows are NOT at this rotation's generation. A fake that counted
        // the whole table regardless would answer the wrong question with a
        // plausible number, which is the failure this check exists to remove.
        const neqFilter = call.filters.find((f) => f.column === "neq");
        const counted = neqFilter
          ? stored.filter((row) => {
              const [column, value] = neqFilter.value as [string, unknown];
              const held =
                (row as Record<string, unknown>)[column] ?? DATA_KEY_GENERATION_DEFAULT;
              return held !== value;
            })
          : stored;
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

      // Honour .gt(column, value), which is how a keyset walk asks for the rows
      // after its cursor. A fake that ignored it would hand back page one for
      // ever and the walk would never terminate.
      const gtFilter = call.filters.find((f) => f.column === "gt");
      const afterCursor = gtFilter
        ? view.filter((row) => {
            const [column, value] = gtFilter.value as [string, unknown];
            return String((row as Record<string, unknown>)[column]) > String(value);
          })
        : view;

      // Honour .limit(n), and .range(from, to). A fake that always returns the
      // same page regardless of its arguments can never exercise pagination,
      // and a fixture of TRANSACTION_PAGE_SIZE or more rows would loop forever
      // against it instead of failing loudly (see the paging test below).
      //
      // .range is modelled even though the walk no longer uses it. That is
      // deliberate: putting offset paging back in the source has to RUN these
      // fixtures and go red on them, not error on a chain method the fake does
      // not have. A harness that cannot run the old version cannot show the new
      // test failing against it.
      const rangeFilter = call.filters.find((f) => f.column === "range");
      const limitFilter = call.filters.find((f) => f.column === "limit");
      const page = rangeFilter
        ? afterCursor.slice(
            (rangeFilter.value as [number, number])[0],
            (rangeFilter.value as [number, number])[1] + 1,
          )
        : limitFilter
          ? afterCursor.slice(0, limitFilter.value as number)
          : afterCursor;

      const reorder = options.reorderAfterSelect?.[call.table];
      if (reorder) store[call.table] = withDefaults(reorder(stored.slice(), store));

      return { data: page, error: null };
    }
    if (call.table === "user_vault_meta") {
      return options.metaUpdate ?? { data: [{ user_id: "user-1" }], error: null };
    }

    // A row update that matched a row hands that row back when it is asked for
    // one with .select(). The DEFAULT therefore has to be a match: returning an
    // empty array by default would make every migrating test below look like a
    // write that row-level security refused. A test that wants a refused write
    // asks for one explicitly through otherUpdate.
    if (options.otherUpdate) return options.otherUpdate;
    const idFilter = call.filters.find((f) => f.column === "id");

    // And it WRITES. A row that is still in the store gets the update's values,
    // so a read after it sees what the rotation actually stamped rather than
    // the fixture it started from. A row that has gone (deleted by another
    // session in one of the fixtures below) still reports as matched, exactly
    // as before: whether a vanished row should count as written is a separate
    // question and is not what this change is about.
    const target = (store[call.table] ?? []).find(
      (row) => (row as Record<string, unknown>).id === idFilter?.value,
    );
    if (target) Object.assign(target as Record<string, unknown>, call.values ?? {});
    return { data: [{ id: idFilter?.value }], error: null };
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
            gt(column: string, value: unknown) {
              call.filters.push({ column: "gt", value: [column, value] });
              return chain;
            },
            neq(column: string, value: unknown) {
              call.filters.push({ column: "neq", value: [column, value] });
              return chain;
            },
            range(from: number, to: number) {
              call.filters.push({ column: "range", value: [from, to] });
              return Promise.resolve(resultFor(call));
            },
            limit(count: number) {
              call.filters.push({ column: "limit", value: count });
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

    // One full page plus one short page ends each walk, and there are two
    // walks: the migrating one and the sweep that confirms it left nothing
    // behind. Four paged reads is the direct evidence both happened and that
    // the cursor advanced within each.
    expect(pagedSelects(calls, "encrypted_transactions").length).toBe(4);
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

    // One full page plus one short page per walk, and there are two walks: the
    // migrating one and the confirming sweep. Four paged reads is the direct
    // evidence the cursor advanced rather than the read being trusted to return
    // everything.
    expect(pagedSelects(calls, "connections").length).toBe(4);
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

  it("goes back and migrates a row the store gained after the page was read", async () => {
    // A sync running in a second tab inserts an encrypted_transactions row
    // while the rotation is in flight. It is written under the OLD MEK by
    // construction, the walk has already read past it, and with no
    // reconciliation at all the meta write still landed: that row was then
    // wrapped under a key nothing stores any more, permanently and with nothing
    // raised.
    //
    // Stopping there is not the fix and this test does not ask for it. At that
    // moment the two rows already rewritten are under a MEK that exists only in
    // this page's memory, so stopping gives up two rows to save one. The missed
    // row is still under the old MEK and the old subkeys are still in memory,
    // so the right move is to migrate it and finish.
    //
    // Take reconcileEveryRow out of vault-persist.ts and this test fails: txn-3
    // is never updated. That is the only reason to trust it. Every defect found
    // on this path so far was a check that could not go red.
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
    ).resolves.toBeUndefined();

    const txnUpdates = calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.table === "encrypted_transactions" && c.op === "update");
    const updatedIds = txnUpdates.map(({ c }) => c.filters.find((f) => f.column === "id")?.value);

    // Every row, each exactly once. The sweep must not rewrite a row that is
    // already under the new MEK: that ciphertext would be handed to the
    // migration helper a second time and would throw.
    expect(updatedIds).toEqual(["txn-1", "txn-2", "txn-3"]);

    // And the late row moved BEFORE the meta write, which is the whole point of
    // reconciling at that instant rather than after it.
    const metaIndex = calls.findIndex((c) => c.table === "user_vault_meta" && c.op === "update");
    for (const { i } of txnUpdates) expect(i).toBeLessThan(metaIndex);
    expect(clearMigrationKeys).toHaveBeenCalledTimes(1);
  });

  it("migrates every connection when one is deleted mid-walk", async () => {
    // THE CASE THAT DEFEATED THE COUNT COMPARISON, kept because it is silent,
    // permanent key loss and the fixture is the clearest statement of it.
    //
    // Offset paging addressed rows by POSITION. Deleting a row from a page that
    // had already been read shifted every later row one place toward the start,
    // so exactly one row fell between the window just read and the next window
    // and was never returned at all. That same delete lowers the exact count by
    // one, and the deleted row's id stays in the migrated set because it was
    // written before it was removed. All three effects cancel one for one.
    //
    // Here: 1000 connections at a page size of 500. Page one reads
    // conn-0000..conn-0499 and conn-0007 is then deleted. Under offset paging,
    // page two asked for positions 500..999 and received conn-0501..conn-0999,
    // because conn-0500 had moved to position 499 inside the window already
    // consumed. The walk now asks for ids above conn-0499 instead, so conn-0500
    // is returned and the shift never happens.
    //
    // WHAT THIS TEST NOW PROVES, stated exactly, because it used to claim more.
    // It proved the sweep was load bearing while the walk paged by offset: the
    // sweep was the only thing that went back for conn-0500. It no longer does,
    // because the walk itself never loses that row now. Keep it as a regression
    // on the delete-mid-walk path and read it as nothing more. The two tests
    // that still fail if reconcileEveryRow is removed are the one above, where
    // a row is INSERTED below the cursor, and the one below it, where a delete
    // and an insert cancel in the count.
    const clearMigrationKeys = vi.fn();
    const rowCount = CONNECTION_PAGE_SIZE * 2;
    const rows = Array.from({ length: rowCount }, (_, i) => ({
      id: `conn-${String(i).padStart(4, "0")}`,
      encrypted_credentials: `creds-${i}`,
      encrypted_label: null,
    }));
    let deleted = false;
    const { client, calls } = makeFakeClient({
      rows: { connections: rows },
      reorderAfterSelect: {
        connections: (current) => {
          if (deleted) return current;
          deleted = true;
          return current.filter((row) => (row as { id: string }).id !== "conn-0007");
        },
      },
    });

    await expect(
      migrateAndPersistRotatedVault(rotateArgs(client, clearMigrationKeys)),
    ).resolves.toBeUndefined();

    const connUpdates = calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.table === "connections" && c.op === "update");
    const updatedIds = connUpdates.map(({ c }) => c.filters.find((f) => f.column === "id")?.value);

    // The row the shift hid. This single assertion is the whole point.
    expect(updatedIds).toContain("conn-0500");

    // And every row moved exactly once, including conn-0007, which was
    // rewritten before it was deleted and must not be rewritten again: handing
    // an already-migrated ciphertext back to the migration helper would throw.
    expect(updatedIds.length).toBe(rowCount);
    expect(new Set(updatedIds)).toEqual(new Set(rows.map((r) => r.id)));

    const metaIndex = calls.findIndex((c) => c.table === "user_vault_meta" && c.op === "update");
    for (const { i } of connUpdates) expect(i).toBeLessThan(metaIndex);
    expect(clearMigrationKeys).toHaveBeenCalledTimes(1);
  });

  it("migrates a late row even when a concurrent delete hides it from the count", async () => {
    // Why the count comparison cannot be rescued by changing the paging. One
    // delete of an already-migrated row and one insert cancel each other
    // exactly in the total, so the arithmetic agrees while a row that was never
    // touched sits under the old MEK. Keyset pagination on id does not help
    // here either: the inserted row is below the cursor either way.
    //
    // txn-1 and txn-2 are read and migrated. The store then loses txn-1 and
    // gains txn-9. The total is still 2 and this run has written 2, so a count
    // comparison sees a clean rotation and stops. Only a sweep finds txn-9.
    const clearMigrationKeys = vi.fn();
    let churned = false;
    const { client, calls } = makeFakeClient({
      rows: {
        encrypted_transactions: [
          { id: "txn-1", encrypted_payload: "payload-1" },
          { id: "txn-2", encrypted_payload: "payload-2" },
        ],
      },
      reorderAfterSelect: {
        encrypted_transactions: (current) => {
          if (churned) return current;
          churned = true;
          return [
            ...current.filter((row) => (row as { id: string }).id !== "txn-1"),
            { id: "txn-9", encrypted_payload: "payload-9" },
          ];
        },
      },
    });

    await expect(
      migrateAndPersistRotatedVault(rotateArgs(client, clearMigrationKeys)),
    ).resolves.toBeUndefined();

    const txnUpdates = calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.table === "encrypted_transactions" && c.op === "update");
    const updatedIds = txnUpdates.map(({ c }) => c.filters.find((f) => f.column === "id")?.value);

    expect(updatedIds).toEqual(["txn-1", "txn-2", "txn-9"]);

    const metaIndex = calls.findIndex((c) => c.table === "user_vault_meta" && c.op === "update");
    for (const { i } of txnUpdates) expect(i).toBeLessThan(metaIndex);
    expect(clearMigrationKeys).toHaveBeenCalledTimes(1);
  });

  it("migrates the row a delete hides from the CONFIRMING sweep", async () => {
    // THE RESIDUAL THE COVERAGE SWEEP CANNOT CLOSE ON ITS OWN, and the reason
    // the walk pages by key. A sweep can only prove what it actually returned,
    // so a shift that happens DURING the confirming sweep is invisible to it.
    //
    // The sequence, at a page size of 500 with the walk paging by OFFSET:
    //
    //   Read 1 (positions 0..499) returns conn-0000..conn-0499 and migrates
    //   them. The page is full, so the walk asks for more.
    //   Read 2 (positions 500..999) returns nothing, and the walk ends. A row
    //   conn-0500 then arrives from another session, above the cursor that has
    //   just stopped, so no walk has ever seen it. It is under the OLD MEK.
    //   The count is 501 against 500 migrated, so the pass does not settle and
    //   a confirming sweep runs. So far the sweep is working.
    //   Read 3 is that sweep's first page, positions 0..499, and returns
    //   conn-0000..conn-0499, all already migrated. conn-0000 is then deleted
    //   by another session. conn-0500 shifts from position 500 to 499, inside
    //   the window the sweep has just consumed.
    //   Read 4 asks for positions 500..999 and gets nothing. added is 0.
    //   The delete also lowered the exact count to 500, and conn-0000's id
    //   stays in the migrated set because it was written before it was removed,
    //   so migrated is 500 too. added > 0 is false and total > migrated is
    //   false. The pass SETTLES, the meta write lands, clearMigrationKeys runs,
    //   and conn-0500 is left wrapped under a MEK that exists nowhere.
    //
    // Paging by key removes step 2 of that: read 4 asks for ids above
    // conn-0499 rather than for position 500, the delete below the cursor moves
    // nothing, and conn-0500 is returned and migrated.
    //
    // PUT `.range(offset, offset + pageSize - 1)` BACK IN walkAndMigrate AND
    // THIS TEST FAILS: conn-0500 is never updated and the rotation still
    // resolves. That is the only reason to trust it. The fake still models
    // .range precisely so that version runs rather than erroring.
    const clearMigrationKeys = vi.fn();
    const rows = Array.from({ length: CONNECTION_PAGE_SIZE }, (_, i) => ({
      id: `conn-${String(i).padStart(4, "0")}`,
      encrypted_credentials: `creds-${i}`,
      encrypted_label: null,
    }));
    const lateId = `conn-${String(CONNECTION_PAGE_SIZE).padStart(4, "0")}`;

    // Counted rather than flagged, because WHICH read the change lands on is
    // the whole fixture. Head count reads do not reach here, so the numbering
    // is the numbering of the paged reads.
    let pagedReads = 0;
    const { client, calls } = makeFakeClient({
      rows: { connections: rows },
      reorderAfterSelect: {
        connections: (current) => {
          pagedReads += 1;
          if (pagedReads === 2) {
            // Read 2 is the end of the first walk. The row arrives after the
            // cursor has passed the end of the table, so it is missed by
            // construction and only a sweep can find it.
            return [
              ...current,
              { id: lateId, encrypted_credentials: "creds-late", encrypted_label: null },
            ];
          }
          if (pagedReads === 3) {
            // Read 3 is the first page of the confirming sweep. Deleting an
            // already-migrated row from the window it has just consumed is what
            // shifts the late row behind an offset cursor already at 500.
            return current.filter((row) => (row as { id: string }).id !== "conn-0000");
          }
          return current;
        },
      },
    });

    await expect(
      migrateAndPersistRotatedVault(rotateArgs(client, clearMigrationKeys)),
    ).resolves.toBeUndefined();

    const connUpdates = calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.table === "connections" && c.op === "update");
    const updatedIds = connUpdates.map(({ c }) => c.filters.find((f) => f.column === "id")?.value);

    // The row the shift would have hidden. This single assertion is the point.
    expect(updatedIds).toContain(lateId);

    // And every row exactly once, including conn-0000, which was rewritten
    // before it was deleted and must not be handed to the migration helper a
    // second time.
    expect(updatedIds.length).toBe(CONNECTION_PAGE_SIZE + 1);
    expect(new Set(updatedIds).size).toBe(CONNECTION_PAGE_SIZE + 1);

    // Before the meta write, which is the only moment at which the rotation can
    // still be finished rather than lost.
    const metaIndex = calls.findIndex((c) => c.table === "user_vault_meta" && c.op === "update");
    expect(metaIndex).toBeGreaterThan(-1);
    for (const { i } of connUpdates) expect(i).toBeLessThan(metaIndex);
    expect(clearMigrationKeys).toHaveBeenCalledTimes(1);
  });

  it("addresses each page by the last id seen, never by a position", async () => {
    // The shape, not the outcome. The test above only goes red when a fixture
    // reproduces the concurrent delete; this one goes red the moment the walk
    // returns to positional paging at all, which is the edit that would quietly
    // reopen the case.
    const rowCount = CONNECTION_PAGE_SIZE + 3;
    const rows = Array.from({ length: rowCount }, (_, i) => ({
      id: `conn-${String(i).padStart(4, "0")}`,
      encrypted_credentials: `creds-${i}`,
      encrypted_label: null,
    }));
    const { client, calls } = makeFakeClient({ rows: { connections: rows } });

    await migrateAndPersistRotatedVault(rotateArgs(client, vi.fn()));

    const reads = pagedSelects(calls, "connections");
    expect(reads.length).toBeGreaterThan(1);
    for (const read of reads) {
      expect(read.filters).toContainEqual({ column: "limit", value: CONNECTION_PAGE_SIZE });
      expect(read.filters).toContainEqual({ column: "order", value: ["id", true] });
      expect(read.filters.some((f) => f.column === "range")).toBe(false);
    }

    // The first page of a walk has no cursor; the one after it asks for the ids
    // above the last id the first page returned.
    const lastOfFirstPage = `conn-${String(CONNECTION_PAGE_SIZE - 1).padStart(4, "0")}`;
    expect(reads[0].filters.some((f) => f.column === "gt")).toBe(false);
    expect(reads[1].filters).toContainEqual({ column: "gt", value: ["id", lastOfFirstPage] });
  });

  it("stops when a row update reports no error and yet changed no row", async () => {
    // The case that decides whether the reconciliation means anything. An
    // update refused by row-level security comes back with no error, so a run
    // that counted it would compare a read against a read: on a run where every
    // write is refused, migrated would equal the table total, the counts would
    // agree, and the irreversible meta write would proceed having re-encrypted
    // nothing at all.
    const clearMigrationKeys = vi.fn();
    const { client, calls } = makeFakeClient({
      ...oneConnection,
      otherUpdate: { data: [], error: null },
    });

    await expect(
      migrateAndPersistRotatedVault(rotateArgs(client, clearMigrationKeys)),
    ).rejects.toThrow(rowNotWrittenMessage("connection", "conn-1"));

    expect(metaUpdates(calls).length).toBe(0);
    expect(clearMigrationKeys).not.toHaveBeenCalled();
  });

  it("does not stop when the total is LOWER than the number of rows this run wrote", async () => {
    // A row deleted in another tab after this run had already rewritten it. A
    // row that is gone cannot be stranded, so stopping here would abandon every
    // row this run wrote over one deletion, for no protective value at all.
    //
    // What this deliberately no longer claims is that a lower total PROVES
    // nothing was missed. It does not: the same delete shifts the offset window
    // and can hide a row in the same operation, which is what the two DELETE
    // tests above exist to catch. A lower total is a reason not to abandon the
    // rotation. It is not evidence that the rotation is complete.
    const clearMigrationKeys = vi.fn();
    const { client, calls } = makeFakeClient({
      ...oneConnection,
      countResult: { connections: { count: 0 } },
    });

    await expect(
      migrateAndPersistRotatedVault(rotateArgs(client, clearMigrationKeys)),
    ).resolves.toBeUndefined();

    expect(metaUpdates(calls).length).toBe(1);
    expect(clearMigrationKeys).toHaveBeenCalledTimes(1);
  });

  it("gives up after a bounded number of passes, naming what it counted", async () => {
    // A table being written about as fast as the rotation can migrate it. Two
    // properties are pinned here. The sweep must not run for ever, and when it
    // does give up the message has to carry the arithmetic, because that is
    // what tells support which set of rows was given up and which was kept.
    const clearMigrationKeys = vi.fn();
    let next = 2;
    const { client, calls } = makeFakeClient({
      rows: { encrypted_transactions: [{ id: "txn-1", encrypted_payload: "payload-1" }] },
      reorderAfterSelect: {
        encrypted_transactions: (rows) => {
          const id = `txn-${next}`;
          next += 1;
          return [...rows, { id, encrypted_payload: `payload-${id}` }];
        },
      },
    });

    await expect(
      migrateAndPersistRotatedVault(rotateArgs(client, clearMigrationKeys)),
    ).rejects.toThrow("migrated 4 of 5 transactions");

    // One walk plus exactly RECONCILE_MAX_PASSES sweeps, and then it stops.
    expect(pagedSelects(calls, "encrypted_transactions").length).toBe(1 + RECONCILE_MAX_PASSES);
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
