import { describe, it, expect } from "vitest";
import {
  generateMekBytes,
  importMekAsHkdf,
  generateVaultSalt,
  encryptString,
  decryptString,
  encoding,
} from "./vault";
import { HKDF_CONTEXTS, deriveCredentialsKey, deriveTransactionsKey } from "./key-derivation";
import {
  buildUpgradeKeyringFromV2,
  dataKeyFor,
  addDataKeyGeneration,
  wrapKeyring,
  unwrapKeyring,
  generateVaultKeyring,
} from "./keyring";

// ---------------------------------------------------------------------------
// Core upgrade invariant tests
//
// These tests enforce one invariant of the v2-to-v3 upgrade:
//
//   Generation 1 of an upgraded v2 vault's keyring MUST hold the exact same
//   byte values that the v2 HKDF derivation produced. Every pre-upgrade row
//   carries data_key_generation=1, and there is no per-row sweep to repair
//   them, so a wrong generation-1 key permanently destroys all pre-upgrade
//   data.
//
// Two kinds of test guard it, and they catch different failures:
//
//   1. Round-trip tests (the block directly below). The encrypt side uses
//      deriveCredentialsKey, the real v2 path, BEFORE buildUpgradeKeyringFromV2
//      is called. They catch a mistake made inside the upgrade helper: a wrong
//      context string passed to it, a wrong salt, or a different source for the
//      key bytes. They CANNOT catch a change to the shared derivation itself.
//      The helper calls the same deriveCredentialsKey and deriveTransactionsKey,
//      so editing an HKDF context string or the salt handling moves both sides
//      together and the round trip stays green.
//
//   2. The pinned known-answer test (the second block). A fixed MEK and salt
//      with the expected key bytes written out as constants. It is the only
//      test in this file that protects rows that are already stored: if the
//      derivation changes, the bytes no longer match and it goes red.
// ---------------------------------------------------------------------------

describe("vault envelope v3: buildUpgradeKeyringFromV2", () => {
  it("generation-1 credentials key from upgrade keyring decrypts v2-encrypted ciphertext", async () => {
    const salt = generateVaultSalt();
    const mek = await importMekAsHkdf(generateMekBytes());

    // Step 1: encrypt with the REAL v2 credentials derivation path, before any upgrade.
    // This is the critical path: the output ciphertext is what a pre-upgrade row holds.
    const v2CredsKey = await deriveCredentialsKey(mek, salt);
    const plaintext = JSON.stringify({ api_key: "hunter2", provider: "blink" });
    const ciphertext = await encryptString(plaintext, v2CredsKey);

    // Step 2: run the upgrade -- freeze the v2-derived values as generation 1 in
    // the new keyring. This is the code under test.
    const keyring = await buildUpgradeKeyringFromV2(mek, salt, null, null);

    // Step 3: decrypt using the generation-1 key from the keyring.
    // dataKeyFor imports the raw bytes stored in keyring.credentials[0] as a CryptoKey.
    const gen1Key = await dataKeyFor(keyring, "credentials", 1);
    const decrypted = await decryptString(ciphertext, gen1Key);

    // The plaintext MUST round-trip exactly. If it does, the generation-1 entry
    // holds the same bytes the v2 path used. If buildUpgradeKeyringFromV2 drifts
    // (wrong context, wrong salt, wrong derivation), this assertion fails.
    expect(decrypted).toBe(plaintext);
  });

  it("generation-1 transactions key from upgrade keyring decrypts v2-encrypted ciphertext", async () => {
    const salt = generateVaultSalt();
    const mek = await importMekAsHkdf(generateMekBytes());

    // Same pattern for transactions: encrypt on the real v2 path first.
    const v2TxnKey = await deriveTransactionsKey(mek, salt);
    const plaintext = JSON.stringify({ id: "tx-1", adapter: "blink", direction: "in" });
    const ciphertext = await encryptString(plaintext, v2TxnKey);

    const keyring = await buildUpgradeKeyringFromV2(mek, salt, null, null);

    const gen1Key = await dataKeyFor(keyring, "transactions", 1);
    const decrypted = await decryptString(ciphertext, gen1Key);
    expect(decrypted).toBe(plaintext);
  });

  it("different MEKs produce different generation-1 keys (sanity: not constant output)", async () => {
    const salt = generateVaultSalt();
    const mek1 = await importMekAsHkdf(generateMekBytes());
    const mek2 = await importMekAsHkdf(generateMekBytes());

    const keyring1 = await buildUpgradeKeyringFromV2(mek1, salt, null, null);
    const keyring2 = await buildUpgradeKeyringFromV2(mek2, salt, null, null);

    // Keys derived from different MEKs must differ.
    expect(keyring1.credentials[0].keyB64).not.toBe(keyring2.credentials[0].keyB64);
    expect(keyring1.transactions[0].keyB64).not.toBe(keyring2.transactions[0].keyB64);
  });

  it("different salts produce different generation-1 keys (sanity: salt is bound)", async () => {
    const mek = await importMekAsHkdf(generateMekBytes());
    const salt1 = generateVaultSalt();
    const salt2 = generateVaultSalt();

    const keyring1 = await buildUpgradeKeyringFromV2(mek, salt1, null, null);
    const keyring2 = await buildUpgradeKeyringFromV2(mek, salt2, null, null);

    // The vault salt is an HKDF input. Two different salts must produce different keys.
    expect(keyring1.credentials[0].keyB64).not.toBe(keyring2.credentials[0].keyB64);
    expect(keyring1.transactions[0].keyB64).not.toBe(keyring2.transactions[0].keyB64);
  });

  it("carries PQC secrets through the upgrade unchanged", async () => {
    const salt = generateVaultSalt();
    const mek = await importMekAsHkdf(generateMekBytes());

    const keyring = await buildUpgradeKeyringFromV2(
      mek,
      salt,
      "kem-b64-value",
      "sig-b64-value",
    );

    expect(keyring.kemSecretB64).toBe("kem-b64-value");
    expect(keyring.sigSecretB64).toBe("sig-b64-value");
  });

  it("null PQC secrets are preserved as null", async () => {
    const salt = generateVaultSalt();
    const mek = await importMekAsHkdf(generateMekBytes());

    const keyring = await buildUpgradeKeyringFromV2(mek, salt, null, null);

    expect(keyring.kemSecretB64).toBeNull();
    expect(keyring.sigSecretB64).toBeNull();
  });

  it("produced keyring has exactly one generation for each key kind", async () => {
    const salt = generateVaultSalt();
    const mek = await importMekAsHkdf(generateMekBytes());

    const keyring = await buildUpgradeKeyringFromV2(mek, salt, null, null);

    expect(keyring.credentials).toHaveLength(1);
    expect(keyring.credentials[0].generation).toBe(1);
    expect(keyring.transactions).toHaveLength(1);
    expect(keyring.transactions[0].generation).toBe(1);
  });

  it("generation-1 key is 32 bytes (AES-256 = 256 bits)", async () => {
    const salt = generateVaultSalt();
    const mek = await importMekAsHkdf(generateMekBytes());

    const keyring = await buildUpgradeKeyringFromV2(mek, salt, null, null);

    // base64-decode and check byte length
    const credsBytes = Uint8Array.from(atob(keyring.credentials[0].keyB64), (c) =>
      c.charCodeAt(0),
    );
    const txnBytes = Uint8Array.from(atob(keyring.transactions[0].keyB64), (c) =>
      c.charCodeAt(0),
    );
    expect(credsBytes.length).toBe(32);
    expect(txnBytes.length).toBe(32);
  });

  it("credentials and transactions keys differ from each other (different HKDF contexts)", async () => {
    const salt = generateVaultSalt();
    const mek = await importMekAsHkdf(generateMekBytes());

    const keyring = await buildUpgradeKeyringFromV2(mek, salt, null, null);

    // deriveCredentialsKey uses context 'orangerails-creds-v1' and
    // deriveTransactionsKey uses 'orangerails-txns-v1', so they must differ.
    expect(keyring.credentials[0].keyB64).not.toBe(keyring.transactions[0].keyB64);
  });
});

// ---------------------------------------------------------------------------
// Pinned known-answer test for the frozen generation-1 keys
//
// The block above asks whether the upgrade helper returns what the live
// derivation returns. That cannot notice the live derivation itself changing,
// because the helper calls it. This block asks the question that protects
// stored rows: for a fixed MEK and salt, are the derived bytes still the ones
// that existing v2 rows were encrypted under.
//
// Inputs are fixed public test values, not a real vault: MEK bytes 00..1f and
// salt bytes 20..3f, both 32 bytes like the real ones. The expected key bytes
// were computed with an independent HKDF-SHA-256 (RFC 5869, two HMAC-SHA-256
// calls) whose output was first checked against RFC 5869 test case 1, and they
// are written out as constants so a derivation change shows up as a failing diff.
//
// If this goes red, the v2 derivation changed. Do not edit the constants to make
// it pass: stored rows were encrypted under the old bytes, so the constants may
// only change together with a versioned migration of those rows.
// ---------------------------------------------------------------------------

describe("vault envelope v3: pinned generation-1 key bytes (known-answer)", () => {
  // 00 01 02 ... 1f
  const MEK_RAW = Uint8Array.from({ length: 32 }, (_, i) => i);
  // 20 21 22 ... 3f, as the base64 string the vault stores in vault_salt
  const SALT_B64 = encoding.bytesToBase64(Uint8Array.from({ length: 32 }, (_, i) => 0x20 + i));

  const PINNED_HEX = {
    credentials: "f9da83632c1845ddadeda0a33c8f024cb697d15c0481af5215f3dbe6a4a85bb5",
    transactions: "1a6934efaf8cf053a5395b9ecfd290a5aff544382cb2e51a3ea786d91f21b2f0",
  } as const;

  const toHex = (bytes: Uint8Array): string =>
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

  it("pins the two HKDF context strings that stored v2 rows were encrypted under", () => {
    expect(HKDF_CONTEXTS.ORANGERAILS_CREDENTIALS_V1).toBe("orangerails-creds-v1");
    expect(HKDF_CONTEXTS.ORANGERAILS_TRANSACTIONS_V1).toBe("orangerails-txns-v1");
  });

  it("the live v2 derivation produces the pinned credentials and transactions keys", async () => {
    const mek = await importMekAsHkdf(MEK_RAW);

    // deriveCredentialsKey and deriveTransactionsKey import extractable keys, so the
    // raw bytes can be read back and compared.
    const credsKey = await deriveCredentialsKey(mek, SALT_B64);
    const txnKey = await deriveTransactionsKey(mek, SALT_B64);
    const credsRaw = new Uint8Array(await crypto.subtle.exportKey("raw", credsKey));
    const txnRaw = new Uint8Array(await crypto.subtle.exportKey("raw", txnKey));

    expect(toHex(credsRaw)).toBe(PINNED_HEX.credentials);
    expect(toHex(txnRaw)).toBe(PINNED_HEX.transactions);
  });

  it("buildUpgradeKeyringFromV2 freezes exactly the pinned bytes as generation 1", async () => {
    const mek = await importMekAsHkdf(MEK_RAW);

    const keyring = await buildUpgradeKeyringFromV2(mek, SALT_B64, null, null);

    expect(keyring.credentials).toHaveLength(1);
    expect(keyring.transactions).toHaveLength(1);
    expect(keyring.credentials[0].generation).toBe(1);
    expect(keyring.transactions[0].generation).toBe(1);

    const credsBytes = encoding.base64ToBytes(keyring.credentials[0].keyB64);
    const txnBytes = encoding.base64ToBytes(keyring.transactions[0].keyB64);

    expect(toHex(credsBytes)).toBe(PINNED_HEX.credentials);
    expect(toHex(txnBytes)).toBe(PINNED_HEX.transactions);
  });
});

// ---------------------------------------------------------------------------
// Wrap / unwrap with multiple generations
//
// The wrap/unwrap path is exercised by the existing keyring tests, but those
// only cover a single generation. Here we verify that a two-generation keyring
// round-trips correctly -- both generations survive the AES-GCM seal/open and
// emerge with the same key material, in the same order.
//
// This is the shape after a data-key rotation begins: generation 1 for all
// existing rows, generation 2 for new writes. Until the sweep finishes and
// generation 1 is pruned, both must be readable from the keyring.
// ---------------------------------------------------------------------------

describe("vault envelope v3: two-generation keyring wrap/unwrap", () => {
  it("wraps and unwraps a two-generation keyring with all key material intact", async () => {
    const salt = generateVaultSalt();
    const mek = await importMekAsHkdf(generateMekBytes());
    const userId = "00000000-0000-0000-0000-000000000001";
    const epoch = 1;

    // Start with a fresh single-generation keyring, then add generation 2.
    let keyring = generateVaultKeyring();
    keyring = addDataKeyGeneration(keyring, "credentials");
    keyring = addDataKeyGeneration(keyring, "transactions");

    expect(keyring.credentials).toHaveLength(2);
    expect(keyring.credentials[0].generation).toBe(1);
    expect(keyring.credentials[1].generation).toBe(2);
    expect(keyring.transactions).toHaveLength(2);
    expect(keyring.transactions[0].generation).toBe(1);
    expect(keyring.transactions[1].generation).toBe(2);

    // Wrap the keyring.
    const ciphertext = await wrapKeyring(keyring, mek, salt, { userId, keyringEpoch: epoch });

    // Unwrap and verify every generation survives.
    const unwrapped = await unwrapKeyring(ciphertext, mek, salt, { userId, keyringEpoch: epoch });

    expect(unwrapped.credentials).toHaveLength(2);
    expect(unwrapped.transactions).toHaveLength(2);

    const credsGen1 = unwrapped.credentials.find((e) => e.generation === 1);
    const credsGen2 = unwrapped.credentials.find((e) => e.generation === 2);
    const txnGen1 = unwrapped.transactions.find((e) => e.generation === 1);
    const txnGen2 = unwrapped.transactions.find((e) => e.generation === 2);

    expect(credsGen1?.keyB64).toBe(keyring.credentials[0].keyB64);
    expect(credsGen2?.keyB64).toBe(keyring.credentials[1].keyB64);
    expect(txnGen1?.keyB64).toBe(keyring.transactions[0].keyB64);
    expect(txnGen2?.keyB64).toBe(keyring.transactions[1].keyB64);
  });

  it("unwrap fails when binding userId changes (AAD mismatch)", async () => {
    const salt = generateVaultSalt();
    const mek = await importMekAsHkdf(generateMekBytes());
    const userId = "00000000-0000-0000-0000-000000000001";

    const ciphertext = await wrapKeyring(generateVaultKeyring(), mek, salt, {
      userId,
      keyringEpoch: 1,
    });

    // Different userId produces different AAD bytes -- the AES-GCM tag check fails.
    await expect(
      unwrapKeyring(ciphertext, mek, salt, {
        userId: "00000000-0000-0000-0000-000000000002",
        keyringEpoch: 1,
      }),
    ).rejects.toThrow();
  });

  it("unwrap fails when binding epoch changes (AAD mismatch)", async () => {
    const salt = generateVaultSalt();
    const mek = await importMekAsHkdf(generateMekBytes());
    const userId = "00000000-0000-0000-0000-000000000001";

    const ciphertext = await wrapKeyring(generateVaultKeyring(), mek, salt, {
      userId,
      keyringEpoch: 1,
    });

    // A stale epoch replay must not open the blob.
    await expect(
      unwrapKeyring(ciphertext, mek, salt, { userId, keyringEpoch: 2 }),
    ).rejects.toThrow();
  });
});
