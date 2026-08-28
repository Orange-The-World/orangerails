/**
 * Tests for src/lib/co-admin.ts , grant / consume / revoke flows.
 *
 * All crypto work is in-browser (vitest runs with the Web Crypto API).
 * No network calls are made; Supabase is stubbed at the store layer.
 *
 * Coverage:
 *  1. Owner wraps 64-byte subkey blob → admin unwraps → matches original bytes.
 *  2. Unwrapped CryptoKeys can actually encrypt/decrypt data (smoke test).
 *  3. Third-party (non-recipient) cannot unwrap.
 *  4. Admin cannot unwrap a row wrapped for a different admin.
 *  5. After "revoke" (wrapped row deleted from store), subkey load fails with
 *     a clear "may have been revoked" error.
 *     NOTE: This is a store-layer test, not a cryptographic revocation test.
 *     The cached-subkey-in-tab limitation is documented in
 *     docs/OrangeRails-CoAdmins.md , once keys are unwrapped into CryptoKey
 *     objects in browser memory, they remain usable until the tab closes.
 */

import { describe, it, expect } from "vitest";
import { generateHybridKemKeyPair } from "../pqc";
import { importAesKey } from "../vault";
import { wrapBlob64, unwrapBlob64, upsertWrappedDataKeyEnvelope } from "../co-admin";

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Build a fake owner blob: concat two 32-byte subkeys. */
function makeBlob(credsRaw: Uint8Array, txnsRaw: Uint8Array): Uint8Array {
  const blob = new Uint8Array(64);
  blob.set(credsRaw, 0);
  blob.set(txnsRaw, 32);
  return blob;
}

/** Unwrap blob and import the two subkeys. */
async function consumeBlob(
  wrappedBytes: Uint8Array,
  ownSecretKey: Uint8Array,
): Promise<{ credentialsKey: CryptoKey; transactionsKey: CryptoKey; blob: Uint8Array }> {
  const blob = await unwrapBlob64(wrappedBytes, ownSecretKey);
  const credentialsKey = await importAesKey(blob.slice(0, 32).buffer);
  const transactionsKey = await importAesKey(blob.slice(32, 64).buffer);
  return { credentialsKey, transactionsKey, blob };
}

// ------------------------------------------------------------------
// 1 + 2. Round-trip: owner wraps → admin unwraps → keys work.
// ------------------------------------------------------------------

describe("co-admin: grant → consume round-trip", () => {
  it("admin unwraps the 64-byte blob to the original two subkeys", async () => {
    const ownerCreds = randomBytes(32);
    const ownerTxns = randomBytes(32);
    const adminKp = generateHybridKemKeyPair();

    const wrappedBytes = await wrapBlob64(makeBlob(ownerCreds, ownerTxns), adminKp.publicKey);
    const { blob } = await consumeBlob(wrappedBytes, adminKp.secretKey);

    expect(bytesEqual(blob.slice(0, 32), ownerCreds)).toBe(true);
    expect(bytesEqual(blob.slice(32, 64), ownerTxns)).toBe(true);
  });

  it("unwrapped CryptoKeys can encrypt and decrypt a test value", async () => {
    const adminKp = generateHybridKemKeyPair();
    const wrappedBytes = await wrapBlob64(
      makeBlob(randomBytes(32), randomBytes(32)),
      adminKp.publicKey,
    );
    const { credentialsKey, transactionsKey } = await consumeBlob(wrappedBytes, adminKp.secretKey);

    for (const key of [credentialsKey, transactionsKey]) {
      const iv = randomBytes(12);
      const plaintext = new TextEncoder().encode("test-value");
      const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plaintext);
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ct);
      expect(new TextDecoder().decode(pt)).toBe("test-value");
    }
  });
});

// ------------------------------------------------------------------
// 3 + 4. Cross-recipient isolation.
// ------------------------------------------------------------------

describe("co-admin: cross-recipient isolation", () => {
  it("a third-party user (non-recipient) cannot unwrap", async () => {
    const adminKp = generateHybridKemKeyPair();
    const eaveKp = generateHybridKemKeyPair(); // not the intended recipient

    const wrappedBytes = await wrapBlob64(
      makeBlob(randomBytes(32), randomBytes(32)),
      adminKp.publicKey,
    );

    await expect(consumeBlob(wrappedBytes, eaveKp.secretKey)).rejects.toBeDefined();
  });

  it("admin2 cannot unwrap a blob wrapped for admin1", async () => {
    const admin1Kp = generateHybridKemKeyPair();
    const admin2Kp = generateHybridKemKeyPair();

    const wrappedForAdmin1 = await wrapBlob64(
      makeBlob(randomBytes(32), randomBytes(32)),
      admin1Kp.publicKey,
    );

    await expect(consumeBlob(wrappedForAdmin1, admin2Kp.secretKey)).rejects.toBeDefined();
  });
});

// ------------------------------------------------------------------
// 5. Revocation (store-layer).
// ------------------------------------------------------------------

describe("co-admin: revocation (store-layer)", () => {
  it("after revoke the wrapped row is gone , subkey load fails with clear error", async () => {
    const adminKp = generateHybridKemKeyPair();
    const wrappedBytes = await wrapBlob64(
      makeBlob(randomBytes(32), randomBytes(32)),
      adminKp.publicKey,
    );

    // In-memory stub simulating wrapped_data_keys.
    let store: Uint8Array | null = wrappedBytes;

    async function loadFromStore(): Promise<void> {
      if (!store) {
        // Mirrors what the VaultContext wrapper raises when no row is found.
        throw new Error(
          "No wrapped key found for this workspace. The grant may have been revoked.",
        );
      }
      await consumeBlob(store, adminKp.secretKey); // succeeds when store is non-null
    }

    // Before revoke: succeeds.
    await expect(loadFromStore()).resolves.toBeUndefined();

    // Revoke = delete row.
    store = null;

    // After revoke: clear error.
    await expect(loadFromStore()).rejects.toThrow(/revoked/);

    // NOTE: If consumeBlob had been called before revoke, the in-memory
    // CryptoKey objects would still work until the tab closes. This is the
    // documented MVP cached-subkey-in-tab limitation.
  });
});

// ------------------------------------------------------------------
// 6. upsertWrappedDataKeyEnvelope (DEV-0416): a re-grant after a partial
//    grant or revoke replaces a stranded envelope instead of failing.
// ------------------------------------------------------------------

describe("co-admin: upsertWrappedDataKeyEnvelope replaces a stranded envelope", () => {
  /**
   * A minimal in-memory stand-in for the wrapped_data_keys table, keyed by
   * (data_key_id, recipient_user_id) the same way the real unique
   * constraint from PR #973 is. insert() reports a Postgres-shaped
   * unique_violation (code 23505) the same way Supabase would, so this
   * exercises the exact conflict path the fix is for without a live
   * database.
   */
  function makeWrappedKeysStore() {
    const rows = new Map<string, Record<string, unknown>>();

    function keyOf(dataKeyId: unknown, recipientUserId: unknown): string {
      return `${String(dataKeyId)}|${String(recipientUserId)}`;
    }

    const supabase = {
      from(table: string) {
        if (table !== "wrapped_data_keys") throw new Error(`unexpected table: ${table}`);
        return {
          insert(row: Record<string, unknown>) {
            const key = keyOf(row.data_key_id, row.recipient_user_id);
            if (rows.has(key)) {
              return Promise.resolve({
                data: null,
                error: {
                  code: "23505",
                  message:
                    'duplicate key value violates unique constraint "wrapped_data_keys_data_key_id_recipient_user_id_key"',
                },
              });
            }
            rows.set(key, { ...row });
            return Promise.resolve({ data: [{ ...row }], error: null });
          },
          update(values: Record<string, unknown>) {
            const filters: Record<string, unknown> = {};
            const builder = {
              eq(col: string, val: string) {
                filters[col] = val;
                return builder;
              },
              select() {
                const key = keyOf(filters.data_key_id, filters.recipient_user_id);
                if (!rows.has(key)) return Promise.resolve({ data: [], error: null });
                const existing = rows.get(key) ?? {};
                rows.set(key, { ...existing, ...values });
                return Promise.resolve({
                  data: [{ recipient_user_id: filters.recipient_user_id }],
                  error: null,
                });
              },
            };
            return builder;
          },
        };
      },
    };

    return {
      supabase: supabase as unknown as Parameters<typeof upsertWrappedDataKeyEnvelope>[0],
      rows,
      keyOf,
    };
  }

  it("inserts a fresh envelope when none exists yet", async () => {
    const { supabase, rows, keyOf } = makeWrappedKeysStore();

    await upsertWrappedDataKeyEnvelope(supabase, {
      dataKeyId: "workspace-1",
      recipientUserId: "admin-1",
      wrappedCiphertextB64: "first-ciphertext",
      algorithm: "hybrid-x25519-mlkem768-blob64",
      grantSig: "first-signature",
    });

    const row = rows.get(keyOf("workspace-1", "admin-1"));
    expect(row?.wrapped_ciphertext).toBe("first-ciphertext");
    expect(row?.grant_sig).toBe("first-signature");
  });

  it("replaces a stranded envelope for the same recipient with the fresh ciphertext and signature, never the old ones", async () => {
    const { supabase, rows, keyOf } = makeWrappedKeysStore();

    // Simulates the envelope left behind by an earlier partial grant or
    // revoke: the row exists with no caller left holding a reference to it.
    await upsertWrappedDataKeyEnvelope(supabase, {
      dataKeyId: "workspace-1",
      recipientUserId: "admin-1",
      wrappedCiphertextB64: "stale-ciphertext",
      algorithm: "hybrid-x25519-mlkem768-blob64",
      grantSig: "stale-signature",
    });

    // Re-grant to the same person: must succeed, and must not fail with the
    // raw unique-violation the constraint from PR #973 would otherwise
    // surface.
    await expect(
      upsertWrappedDataKeyEnvelope(supabase, {
        dataKeyId: "workspace-1",
        recipientUserId: "admin-1",
        wrappedCiphertextB64: "fresh-ciphertext",
        algorithm: "hybrid-x25519-mlkem768-blob64",
        grantSig: "fresh-signature",
      }),
    ).resolves.toBeUndefined();

    const row = rows.get(keyOf("workspace-1", "admin-1"));
    // Exactly one row for this pair, holding the NEW envelope. The old
    // ciphertext and signature must not survive: a signature made for the
    // old ciphertext would not verify against the new one anyway.
    expect(rows.size).toBe(1);
    expect(row?.wrapped_ciphertext).toBe("fresh-ciphertext");
    expect(row?.grant_sig).toBe("fresh-signature");
  });

  it("does not disturb a different recipient's envelope for the same workspace key", async () => {
    const { supabase, rows, keyOf } = makeWrappedKeysStore();

    await upsertWrappedDataKeyEnvelope(supabase, {
      dataKeyId: "workspace-1",
      recipientUserId: "admin-1",
      wrappedCiphertextB64: "admin-1-ciphertext",
      algorithm: "hybrid-x25519-mlkem768-blob64",
      grantSig: "admin-1-signature",
    });
    await upsertWrappedDataKeyEnvelope(supabase, {
      dataKeyId: "workspace-1",
      recipientUserId: "admin-2",
      wrappedCiphertextB64: "admin-2-ciphertext",
      algorithm: "hybrid-x25519-mlkem768-blob64",
      grantSig: "admin-2-signature",
    });

    expect(rows.size).toBe(2);
    expect(rows.get(keyOf("workspace-1", "admin-1"))?.wrapped_ciphertext).toBe("admin-1-ciphertext");
    expect(rows.get(keyOf("workspace-1", "admin-2"))?.wrapped_ciphertext).toBe("admin-2-ciphertext");
  });

  it("propagates a non-conflict insert error via its own message, not a stringified error object", async () => {
    const supabase = {
      from() {
        return {
          insert() {
            return Promise.resolve({
              data: null,
              error: { code: "42501", message: "permission denied for table wrapped_data_keys" },
            });
          },
        };
      },
    } as unknown as Parameters<typeof upsertWrappedDataKeyEnvelope>[0];

    await expect(
      upsertWrappedDataKeyEnvelope(supabase, {
        dataKeyId: "workspace-1",
        recipientUserId: "admin-1",
        wrappedCiphertextB64: "ciphertext",
        algorithm: "hybrid-x25519-mlkem768-blob64",
        grantSig: "signature",
      }),
    ).rejects.toThrow(/permission denied for table wrapped_data_keys/);
  });

  it("surfaces a plain-English error when a stranded envelope exists but cannot be replaced", async () => {
    const supabase = {
      from() {
        return {
          insert() {
            return Promise.resolve({
              data: null,
              error: {
                code: "23505",
                message:
                  'duplicate key value violates unique constraint "wrapped_data_keys_data_key_id_recipient_user_id_key"',
              },
            });
          },
          update() {
            const builder = {
              eq() {
                return builder;
              },
              select() {
                return Promise.resolve({
                  data: null,
                  error: { message: "permission denied for table wrapped_data_keys" },
                });
              },
            };
            return builder;
          },
        };
      },
    } as unknown as Parameters<typeof upsertWrappedDataKeyEnvelope>[0];

    // The leading sentence must be plain English, not the raw constraint
    // name from the unique-violation the insert above hit.
    await expect(
      upsertWrappedDataKeyEnvelope(supabase, {
        dataKeyId: "workspace-1",
        recipientUserId: "admin-1",
        wrappedCiphertextB64: "ciphertext",
        algorithm: "hybrid-x25519-mlkem768-blob64",
        grantSig: "signature",
      }),
    ).rejects.toThrow(/already had a stored key from an earlier attempt, and replacing it failed/);
  });
});
