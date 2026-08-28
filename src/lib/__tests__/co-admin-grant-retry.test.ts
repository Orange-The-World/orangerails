/**
 * Tests for the grant-retry self-heal in src/lib/co-admin.ts (DEV-0416).
 *
 * WHAT THIS PINS. grantCoAdmin inserts a wrapped_data_keys row (step f) and
 * then a workspace_admins row (step g). If the first insert lands and the
 * second one fails, the envelope row used to survive with nothing pointing
 * at it. Before the unique constraint on (data_key_id, recipient_user_id)
 * added for DL-2261, a bare retry inserted a SECOND envelope row
 * for the same recipient, which broke the app's maybeSingle() read
 * permanently and silently (DEV-0412). After that constraint, a bare retry
 * instead failed forever on a raw unique-violation, because the stranded
 * row never went away on its own. That is the residual the constraint made
 * visible, and it is what this file proves is now fixed.
 *
 * WHY THE FAKE MODELS THE CONSTRAINT ITSELF, not just a scripted error. A
 * fix that caught and swallowed a duplicate-key error without truly
 * deleting the stale row would still leave two conflicting rows, or would
 * silently keep the old (stale) ciphertext. Modelling the unique constraint
 * as real state in the fake means the second grantCoAdmin call only
 * succeeds if the code actually removed the stranded row before inserting,
 * and the ciphertext assertion means it cannot pass by silently reusing the
 * old row instead of replacing it.
 *
 * WHY THIS USES THE REAL CRYPTO instead of stubbing deriveMekRaw or
 * wrapBlob64. grantCoAdmin's own behaviour under a real Argon2id derivation
 * and a real hybrid-KEM wrap is exactly what a partial-failure retry runs
 * through in production; stubbing those out would only prove the plumbing
 * around them, not the function.
 */

import { describe, it, expect } from "vitest";
import { generateHybridKemKeyPair, generateSigKeyPair } from "../pqc";
import { deriveMekRaw, encryptString } from "../vault";
import { derivePqcSecretWrapKey } from "../key-derivation";
import { grantCoAdmin, type CoAdminSupabaseLike } from "../co-admin";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function randomSaltB64(): string {
  const salt = new Uint8Array(32);
  crypto.getRandomValues(salt);
  return bytesToBase64(salt);
}

interface FakeOptions {
  /** how many workspace_admins inserts should fail (network drop) before succeeding */
  adminInsertFailures?: number;
  /** force every wrapped_data_keys insert to return this error outright */
  forceWdkInsertError?: { code?: string; message: string };
}

interface WdkRow {
  data_key_id: unknown;
  recipient_user_id: unknown;
  wrapped_ciphertext: unknown;
  algorithm: unknown;
  grant_sig: unknown;
}

function makeFakeClient(opts: FakeOptions = {}) {
  const state: { wrapped_data_keys: WdkRow[]; workspace_admins: Array<Record<string, unknown>> } =
    {
      wrapped_data_keys: [],
      workspace_admins: [],
    };
  let adminInsertFailuresRemaining = opts.adminInsertFailures ?? 0;

  const client = {
    from(table: string) {
      if (table === "wrapped_data_keys") {
        return {
          insert(row: WdkRow) {
            if (opts.forceWdkInsertError) {
              return Promise.resolve({ data: null, error: opts.forceWdkInsertError });
            }
            const dup = state.wrapped_data_keys.find(
              (r) =>
                r.data_key_id === row.data_key_id && r.recipient_user_id === row.recipient_user_id,
            );
            if (dup) {
              // The real shape PostgREST returns for the PR #973 constraint.
              return Promise.resolve({
                data: null,
                error: {
                  code: "23505",
                  message:
                    'duplicate key value violates unique constraint "wrapped_data_keys_data_key_id_recipient_user_id_key"',
                },
              });
            }
            state.wrapped_data_keys.push(row);
            return Promise.resolve({ data: [row], error: null });
          },
          delete() {
            const filters: Array<{ column: string; value: unknown }> = [];
            const builder = {
              eq(column: string, value: unknown) {
                filters.push({ column, value });
                return builder;
              },
              then(resolve: (v: { error: unknown }) => void) {
                state.wrapped_data_keys = state.wrapped_data_keys.filter(
                  (r) => !filters.every((f) => (r as Record<string, unknown>)[f.column] === f.value),
                );
                resolve({ error: null });
              },
            };
            return builder;
          },
        };
      }
      if (table === "workspace_admins") {
        return {
          insert(row: Record<string, unknown>) {
            if (adminInsertFailuresRemaining > 0) {
              adminInsertFailuresRemaining--;
              return Promise.resolve({ data: null, error: { message: "network drop" } });
            }
            state.workspace_admins.push(row);
            return Promise.resolve({ data: [row], error: null });
          },
        };
      }
      throw new Error(`this test client does not model table ${table}`);
    },
  };

  return {
    client: client as unknown as CoAdminSupabaseLike,
    state,
  };
}

describe("grantCoAdmin heals a stranded envelope on retry (DEV-0416)", () => {
  it(
    "replaces a stranded wrapped_data_keys row left by a failed workspace_admins insert",
    async () => {
      const ownerPassword = "correct-horse-battery-staple-42";
      const ownerSaltB64 = randomSaltB64();

      const mekRaw = await deriveMekRaw(ownerPassword, ownerSaltB64);
      const mekHkdf = await crypto.subtle.importKey(
        "raw",
        mekRaw as BufferSource,
        { name: "HKDF" },
        false,
        ["deriveBits"],
      );
      const pqcWrapKey = await derivePqcSecretWrapKey(mekHkdf, ownerSaltB64);
      const sig = generateSigKeyPair();
      const ownerSigSecretWrapped = await encryptString(bytesToBase64(sig.secretKey), pqcWrapKey);

      const adminKp = generateHybridKemKeyPair();

      const { client, state } = makeFakeClient({ adminInsertFailures: 1 });

      const params = {
        ownerUserId: "owner-1",
        ownerSaltB64,
        ownerPassword,
        ownerSigSecretWrapped,
        targetUserId: "admin-1",
        targetKemPubB64: bytesToBase64(adminKp.publicKey),
        existingKeyId: "workspace-key-1",
        supabase: client,
      };

      // First attempt: the envelope insert lands, the admin-list insert then
      // fails. This is the exact partial state DEV-0416 describes.
      await expect(grantCoAdmin(params)).rejects.toThrow();
      expect(state.wrapped_data_keys).toHaveLength(1);
      expect(state.workspace_admins).toHaveLength(0);
      const strandedCiphertext = state.wrapped_data_keys[0].wrapped_ciphertext;

      // Second attempt, the retry. Must succeed, must not still collide with
      // the stranded row, and must not silently reuse its bytes.
      const result = await grantCoAdmin(params);
      expect(result.workspaceKeyId).toBe("workspace-key-1");
      expect(state.wrapped_data_keys).toHaveLength(1);
      expect(state.workspace_admins).toHaveLength(1);
      expect(state.wrapped_data_keys[0].wrapped_ciphertext).not.toBe(strandedCiphertext);
    },
    20000,
  );

  it(
    "reports a residual insert collision in plain language, not the raw constraint name",
    async () => {
      const ownerPassword = "correct-horse-battery-staple-43";
      const ownerSaltB64 = randomSaltB64();

      const mekRaw = await deriveMekRaw(ownerPassword, ownerSaltB64);
      const mekHkdf = await crypto.subtle.importKey(
        "raw",
        mekRaw as BufferSource,
        { name: "HKDF" },
        false,
        ["deriveBits"],
      );
      const pqcWrapKey = await derivePqcSecretWrapKey(mekHkdf, ownerSaltB64);
      const sig = generateSigKeyPair();
      const ownerSigSecretWrapped = await encryptString(bytesToBase64(sig.secretKey), pqcWrapKey);

      const adminKp = generateHybridKemKeyPair();

      const { client } = makeFakeClient({
        forceWdkInsertError: {
          code: "23505",
          message:
            'duplicate key value violates unique constraint "wrapped_data_keys_data_key_id_recipient_user_id_key"',
        },
      });

      const error = await grantCoAdmin({
        ownerUserId: "owner-1",
        ownerSaltB64,
        ownerPassword,
        ownerSigSecretWrapped,
        targetUserId: "admin-1",
        targetKemPubB64: bytesToBase64(adminKp.publicKey),
        existingKeyId: "workspace-key-1",
        supabase: client,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/already in progress|try again/i);
      expect((error as Error).message).not.toMatch(/duplicate key/i);
      expect((error as Error).message).not.toMatch(/constraint/i);
    },
    20000,
  );
});
