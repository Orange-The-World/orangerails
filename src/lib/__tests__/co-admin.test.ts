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
import { wrapBlob64, unwrapBlob64 } from "../co-admin";

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
