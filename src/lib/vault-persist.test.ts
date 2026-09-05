import { describe, expect, it } from "vitest";

import {
  CREDENTIALS_HELD_BY_PROVIDER,
  RECOVERY_META_NOT_SAVED_MESSAGE,
  ROTATION_UNREADABLE_CREDENTIALS_MESSAGE,
  SEALED_UNDER_VAULT_KEY,
  migrateAndPersistRotatedVault,
  type VaultPersistClient,
} from "./vault-persist";

type Row = Record<string, unknown>;

interface Tables {
  connections: Row[];
  encrypted_transactions: Row[];
  user_vault_meta: Row[];
}

interface RecordedWrite {
  table: string;
  id: unknown;
  patch: Row;
}

interface RecordedSelect {
  table: string;
  filters: Array<[string, unknown]>;
}

/**
 * A supabase double that supports exactly the chains this module builds, and
 * that records what was read and what was written.
 *
 * The write log is the point. Every property this file pins is of the form
 * "after X, these rows and no others had been rewritten", and a double that
 * only reports the final table contents cannot tell a row that was never
 * written from one that was written back to the same value.
 */
function makeFake(tables: Tables) {
  const writes: RecordedWrite[] = [];
  const selects: RecordedSelect[] = [];

  const client = {
    from(table: string) {
      const rows = () => tables[table as keyof Tables] ?? [];

      return {
        select(_columns: string) {
          const filters: Array<[string, unknown]> = [];
          const builder = {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return builder;
            },
            order(_column: string, _options?: unknown) {
              return builder;
            },
            range(from: number, to: number) {
              selects.push({ table, filters: [...filters] });
              const matched = rows()
                .filter((row) => filters.every(([column, value]) => row[column] === value))
                .slice()
                .sort((a, b) => String(a.id).localeCompare(String(b.id)));
              return Promise.resolve({ data: matched.slice(from, to + 1), error: null });
            },
          };
          return builder;
        },

        update(patch: Row) {
          const filters: Array<[string, unknown]> = [];
          let applied: Row[] | null = null;

          const apply = () => {
            if (applied) return applied;
            const matched = rows().filter((row) =>
              filters.every(([column, value]) => row[column] === value),
            );
            for (const row of matched) {
              writes.push({ table, id: row.id, patch: { ...patch } });
              Object.assign(row, patch);
            }
            applied = matched;
            return matched;
          };

          const builder = {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return builder;
            },
            select(_columns: string) {
              return Promise.resolve({
                data: apply().map((row) => ({ user_id: row.user_id })),
                error: null,
              });
            },
            then<T>(
              onFulfilled: (value: { error: null }) => T,
              onRejected?: (reason: unknown) => T,
            ) {
              return Promise.resolve(null)
                .then(() => {
                  apply();
                  return { error: null as null };
                })
                .then(onFulfilled, onRejected);
            },
          };
          return builder;
        },
      };
    },
  };

  return {
    client: client as unknown as VaultPersistClient,
    tables,
    writes,
    selects,
  };
}

/**
 * A key opens what it sealed and throws on anything else. This is the only
 * behaviour of the real crypto that this module's correctness depends on, and
 * a double that returned a value for every input would make every test here
 * pass against the defective version.
 */
const credentialsKey = async (ciphertext: string): Promise<string> => {
  if (!ciphertext.startsWith("creds:")) {
    throw new Error(`credentials subkey cannot open ${ciphertext}`);
  }
  return `creds-new:${ciphertext.slice("creds:".length)}`;
};

const transactionsKey = async (ciphertext: string): Promise<string> => {
  if (!ciphertext.startsWith("txn:")) {
    throw new Error(`transactions subkey cannot open ${ciphertext}`);
  }
  return `txn-new:${ciphertext.slice("txn:".length)}`;
};

function meta(): Row[] {
  return [
    {
      user_id: "user-1",
      enc_mek_ciphertext: "old-mek",
      recovery_ciphertext: "old-recovery",
      vault_verifier_ciphertext: "old-verifier",
      vault_key_version: 1,
    },
  ];
}

function run(fake: ReturnType<typeof makeFake>, overrides: Record<string, unknown> = {}) {
  let cleared = false;
  const promise = migrateAndPersistRotatedVault({
    supabase: fake.client,
    userId: "user-1",
    priorRecoveryCiphertext: "old-recovery",
    newEncMekCiphertext: "new-mek",
    newRecoveryCiphertext: "new-recovery",
    newVerifierCiphertext: "new-verifier",
    vaultKeyVersion: 2,
    migrateCredentialsCiphertext: credentialsKey,
    migrateTransactionCiphertext: transactionsKey,
    clearMigrationKeys: () => {
      cleared = true;
    },
    ...overrides,
  });
  return { promise, wasCleared: () => cleared };
}

const rowsFor = (fake: ReturnType<typeof makeFake>, table: keyof Tables) =>
  fake.writes.filter((write) => write.table === table).map((write) => write.id);

describe("migrateAndPersistRotatedVault: rows this key did not seal", () => {
  it("re-encrypts only the transactions sealed under the vault key and leaves the rest alone", async () => {
    const fake = makeFake({
      connections: [{ id: "conn-a", encrypted_credentials: "creds:a", encrypted_label: null }],
      encrypted_transactions: [
        { id: "txn-1", encrypted_payload: "txn:1", sealed_under: "ort" },
        { id: "txn-2", encrypted_payload: "opk-sealed:2", sealed_under: "opk" },
        { id: "txn-3", encrypted_payload: "txn:3", sealed_under: "ort" },
        { id: "txn-4", encrypted_payload: "opk-sealed:4", sealed_under: "opk" },
      ],
      user_vault_meta: meta(),
    });

    const { promise, wasCleared } = run(fake);
    await expect(promise).resolves.toBeUndefined();

    // The read asked the database for the rows this key sealed. Without this
    // the OPK rows reach the transactions subkey, which cannot open them.
    const txnSelect = fake.selects.find((s) => s.table === "encrypted_transactions");
    expect(txnSelect?.filters).toContainEqual(["sealed_under", SEALED_UNDER_VAULT_KEY]);

    expect(rowsFor(fake, "encrypted_transactions")).toEqual(["txn-1", "txn-3"]);

    const byId = (id: string) => fake.tables.encrypted_transactions.find((r) => r.id === id);
    expect(byId("txn-1")?.encrypted_payload).toBe("txn-new:1");
    expect(byId("txn-3")?.encrypted_payload).toBe("txn-new:3");
    expect(byId("txn-2")?.encrypted_payload).toBe("opk-sealed:2");
    expect(byId("txn-4")?.encrypted_payload).toBe("opk-sealed:4");

    expect(fake.tables.user_vault_meta[0].recovery_ciphertext).toBe("new-recovery");
    expect(wasCleared()).toBe(true);
  });

  it("leaves a provider held credential in place but still moves that connection's label", async () => {
    const fake = makeFake({
      connections: [
        {
          id: "conn-a",
          encrypted_credentials: CREDENTIALS_HELD_BY_PROVIDER,
          encrypted_label: "creds:label-a",
        },
      ],
      encrypted_transactions: [],
      user_vault_meta: meta(),
    });

    const { promise } = run(fake);
    await expect(promise).resolves.toBeUndefined();

    const conn = fake.tables.connections[0];
    expect(conn.encrypted_credentials).toBe(CREDENTIALS_HELD_BY_PROVIDER);
    expect(conn.encrypted_label).toBe("creds-new:label-a");

    const connWrite = fake.writes.find((write) => write.table === "connections");
    expect(connWrite?.patch).not.toHaveProperty("encrypted_credentials");
    expect(connWrite?.patch).toHaveProperty("encrypted_label");
  });

  it("writes nothing at all for a provider held connection with no label", async () => {
    const fake = makeFake({
      connections: [
        {
          id: "conn-a",
          encrypted_credentials: CREDENTIALS_HELD_BY_PROVIDER,
          encrypted_label: null,
        },
      ],
      encrypted_transactions: [],
      user_vault_meta: meta(),
    });

    const { promise } = run(fake);
    await expect(promise).resolves.toBeUndefined();

    expect(rowsFor(fake, "connections")).toEqual([]);
    expect(fake.tables.user_vault_meta[0].recovery_ciphertext).toBe("new-recovery");
  });

  it("stops on a credential it cannot open without having rewritten a single row", async () => {
    const fake = makeFake({
      connections: [
        // conn-a sorts first and migrates cleanly, so on the previous version
        // of this file it was already rewritten by the time conn-b threw. That
        // is the unrecoverable state this test exists to forbid.
        { id: "conn-a", encrypted_credentials: "creds:a", encrypted_label: null },
        { id: "conn-b", encrypted_credentials: "sealed-under-something-else", encrypted_label: null },
      ],
      encrypted_transactions: [{ id: "txn-1", encrypted_payload: "txn:1", sealed_under: "ort" }],
      user_vault_meta: meta(),
    });

    const { promise, wasCleared } = run(fake);
    await expect(promise).rejects.toThrow(ROTATION_UNREADABLE_CREDENTIALS_MESSAGE);

    expect(fake.writes).toEqual([]);
    expect(fake.tables.connections[0].encrypted_credentials).toBe("creds:a");
    expect(fake.tables.encrypted_transactions[0].encrypted_payload).toBe("txn:1");
    expect(fake.tables.user_vault_meta[0].recovery_ciphertext).toBe("old-recovery");

    // The old key material is the only thing that can still read this user's
    // rows, and nothing has moved, so it must not be zeroed.
    expect(wasCleared()).toBe(false);
  });

  it("keeps the underlying failure attached rather than discarding it", async () => {
    const fake = makeFake({
      connections: [
        { id: "conn-a", encrypted_credentials: "sealed-under-something-else", encrypted_label: null },
      ],
      encrypted_transactions: [],
      user_vault_meta: meta(),
    });

    const { promise } = run(fake);
    const error = (await promise.catch((err: unknown) => err)) as Error & {
      underlyingError?: Error;
    };

    expect(error.message).toBe(ROTATION_UNREADABLE_CREDENTIALS_MESSAGE);
    expect(error.underlyingError?.message).toContain("credentials subkey cannot open");
  });

  it("still fails loudly when the meta compare and swap matches no row", async () => {
    const fake = makeFake({
      connections: [],
      encrypted_transactions: [{ id: "txn-1", encrypted_payload: "txn:1", sealed_under: "ort" }],
      user_vault_meta: meta(),
    });

    const { promise, wasCleared } = run(fake, { priorRecoveryCiphertext: "stale-recovery" });
    await expect(promise).rejects.toThrow(RECOVERY_META_NOT_SAVED_MESSAGE);
    expect(wasCleared()).toBe(false);
  });
});
