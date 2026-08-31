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
  /** .order(), so a test can prove the page walk asked for a stable order */
  order?: { column: string; ascending: boolean };
  /** .limit() */
  limit?: number;
  /** the keyset cursor, .gt(column, value) */
  gt?: { column: string; value: unknown };
  /** .range(from, to), which this fake now HONOURS instead of ignoring */
  range?: [number, number];
}

/** Plain byte order, the same comparison the keyset cursor uses. */
function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

interface SelectChain {
  then(
    onFulfilled: (value: QueryResult) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ): Promise<unknown>;
  order(column: string, opts?: { ascending?: boolean }): SelectChain;
  limit(count: number): SelectChain;
  gt(column: string, value: unknown): SelectChain;
  range(from: number, to: number): SelectChain;
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
  /**
   * Called before every select resolves. A test uses this to reorder the
   * backing rows mid-loop, which is what an UPDATE does to physical order.
   */
  beforeSelect?: (table: string) => void;
  /**
   * A hard cap on how many rows any select returns, whatever the caller asked
   * for. PostgREST's db-max-rows behaves exactly like this, which is why a
   * short page is not evidence that the table is exhausted.
   */
  maxRows?: number;
}

/**
 * A fake supabase client that records what was asked of it.
 *
 * It reproduces only the shape the persist code uses: from().select() with an
 * optional .order()/.limit()/.gt()/.range(), and from().update().eq().eq()
 * .select(). Every builder is thenable, because the real client is awaited both
 * with and without a trailing .select().
 *
 * The paging arguments are HONOURED, not merely recorded. An earlier version
 * ignored them and returned the same rows for every page, which meant the
 * paging branch of the rotation was never executed by any test and a fixture
 * of a full page or more would have looped forever.
 */
function makeFakeClient(options: FakeOptions = {}) {
  const calls: RecordedCall[] = [];

  function resultFor(call: RecordedCall): QueryResult {
    if (call.op === "select") {
      const override = options.selectResult?.[call.table];
      if (override) return override;
      options.beforeSelect?.(call.table);
      let data = [...((options.rows?.[call.table] ?? []) as Array<Record<string, unknown>>)];
      if (call.order) {
        const column = call.order.column;
        data.sort((a, b) => compareText(String(a[column]), String(b[column])));
        if (!call.order.ascending) data.reverse();
      }
      if (call.gt) {
        const { column, value } = call.gt;
        data = data.filter((row) => String(row[column]) > String(value));
      }
      if (call.range) data = data.slice(call.range[0], call.range[1] + 1);
      if (call.limit !== undefined) data = data.slice(0, call.limit);
      // Applied LAST, and deliberately after .limit(): a server-side cap does
      // not care what the client asked for.
      if (options.maxRows !== undefined) data = data.slice(0, options.maxRows);
      return { data, error: null };
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
            order(column: string, opts?: { ascending?: boolean }) {
              call.order = { column, ascending: opts?.ascending !== false };
              return chain;
            },
            limit(count: number) {
              call.limit = count;
              return chain;
            },
            gt(column: string, value: unknown) {
              call.gt = { column, value };
              return chain;
            },
            range(from: number, to: number) {
              call.range = [from, to];
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

describe("vault recovery: the transaction re-encryption page walk", () => {
  const PAGE_SIZE = 500;

  /** uuid-shaped ids that sort in a known order, so a skip is detectable. */
  function txnFixture(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      encrypted_payload: `payload-${i}`,
    }));
  }

  function updatedIds(calls: RecordedCall[]): string[] {
    return calls
      .filter((c) => c.table === "encrypted_transactions" && c.op === "update")
      .map((c) => c.filters.find((f) => f.column === "id")?.value as string);
  }

  function txnSelects(calls: RecordedCall[]): RecordedCall[] {
    return calls.filter((c) => c.table === "encrypted_transactions" && c.op === "select");
  }

  it("walks both pages of a 501 row fixture and updates every row exactly once", async () => {
    const rows = txnFixture(PAGE_SIZE + 1);
    const { client, calls } = makeFakeClient({ rows: { encrypted_transactions: rows } });

    await migrateAndPersistRotatedVault(rotateArgs(client, vi.fn()));

    // The assertion that can go red, and the reason this test exists. A row
    // this loop fails to select is never re-encrypted, and clearMigrationKeys()
    // then destroys the only key that could still read it.
    const ids = updatedIds(calls);
    expect(new Set(ids)).toEqual(new Set(rows.map((r) => r.id)));
    expect(ids.length).toBe(rows.length);
    // Three, not two. The loop stops on an empty page and on nothing else, so
    // 501 rows cost 500 + 1 + 0. If this ever reads two again, someone has put
    // the short-page break back.
    expect(txnSelects(calls).length).toBe(3);
  });

  it("pages by the primary key in a stable order, never by bare offset", async () => {
    const rows = txnFixture(PAGE_SIZE + 1);
    const { client, calls } = makeFakeClient({ rows: { encrypted_transactions: rows } });

    await migrateAndPersistRotatedVault(rotateArgs(client, vi.fn()));

    const selects = txnSelects(calls);
    for (const select of selects) {
      expect(select.order).toEqual({ column: "id", ascending: true });
      expect(select.limit).toBe(PAGE_SIZE);
      // OFFSET paging over a set this loop is mutating is the defect itself.
      expect(select.range).toBeUndefined();
    }
    expect(selects[0].gt).toBeUndefined();
    expect(selects[1].gt).toEqual({ column: "id", value: rows[PAGE_SIZE - 1].id });
  });

  it("loses no row when the backing set reorders under the loop, as an update does", async () => {
    const rows = txnFixture(PAGE_SIZE + 1);
    const backing = [...rows];
    const { client, calls } = makeFakeClient({
      rows: { encrypted_transactions: backing },
      // Physical order is not logical order. Rotating the array between pages
      // is what a heap rewrite does to an unordered scan: under offset paging
      // rows fall past the boundary and are lost, under keyset paging the
      // cursor is unaffected.
      beforeSelect: (table) => {
        if (table !== "encrypted_transactions") return;
        const first = backing.shift();
        if (first) backing.push(first);
      },
    });

    await migrateAndPersistRotatedVault(rotateArgs(client, vi.fn()));

    expect(new Set(updatedIds(calls))).toEqual(new Set(rows.map((r) => r.id)));
  });

  it("keeps walking when the server caps a page below the size asked for", async () => {
    const rows = txnFixture(PAGE_SIZE + 1);
    const { client, calls } = makeFakeClient({
      rows: { encrypted_transactions: rows },
      // PostgREST's db-max-rows caps a response server-side. A page of 200 in
      // answer to a request for 500 does NOT mean the table is exhausted.
      maxRows: 200,
    });

    await migrateAndPersistRotatedVault(rotateArgs(client, vi.fn()));

    // This is the assertion that goes red if the loop treats a short page as
    // the end. It would stop after 200 of 501 rows, finish without error, and
    // clearMigrationKeys() would then destroy the only key that could still
    // read the other 301.
    expect(new Set(updatedIds(calls))).toEqual(new Set(rows.map((r) => r.id)));
    expect(updatedIds(calls).length).toBe(rows.length);
    // 200 + 200 + 101 + 0.
    expect(txnSelects(calls).length).toBe(4);
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
