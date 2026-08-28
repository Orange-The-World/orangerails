/**
 * Keyring tests , envelope v3.
 *
 * The property under test, and the reason this module exists: rotating the
 * MEK must leave every data key untouched, so a recovery never has to
 * re-encrypt a data row. Everything else here defends that property.
 *
 * Run with:
 *   bunx vitest run src/lib/__tests__/keyring.test.ts
 */

import { describe, expect, test } from "vitest";
import {
  addDataKeyGeneration,
  dataKeyAt,
  dataKeyFor,
  decodeKeyring,
  encodeKeyring,
  generateVaultKeyring,
  KEYRING_VERSION,
  latestDataKey,
  rewrapKeyringUnderNewMek,
  unwrapKeyring,
  withPqcSecrets,
  wrapKeyring,
  type KeyringBinding,
} from "../keyring";
import {
  decryptString,
  encoding,
  encryptString,
  generateMekBytes,
  generateVaultSalt,
  importMekAsHkdf,
} from "../vault";

const BINDING: KeyringBinding = {
  userId: "11111111-2222-3333-4444-555555555555",
  vaultKeyVersion: 3,
};

async function freshMek() {
  return importMekAsHkdf(generateMekBytes());
}

describe("keyring , creation", () => {
  test("generates two independent 32-byte data keys at generation 1", () => {
    const kr = generateVaultKeyring();

    expect(kr.version).toBe(KEYRING_VERSION);
    expect(kr.credentials).toHaveLength(1);
    expect(kr.transactions).toHaveLength(1);
    expect(kr.credentials[0].generation).toBe(1);
    expect(kr.transactions[0].generation).toBe(1);
    expect(encoding.base64ToBytes(kr.credentials[0].keyB64).length).toBe(32);
    expect(encoding.base64ToBytes(kr.transactions[0].keyB64).length).toBe(32);

    // Independent, not two derivations of one thing.
    expect(kr.credentials[0].keyB64).not.toBe(kr.transactions[0].keyB64);
    expect(kr.kemSecretB64).toBeNull();
    expect(kr.sigSecretB64).toBeNull();
  });

  test("two keyrings never share key material", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const kr = generateVaultKeyring();
      seen.add(kr.credentials[0].keyB64);
      seen.add(kr.transactions[0].keyB64);
    }
    expect(seen.size).toBe(20);
  });
});

describe("keyring , wrap and unwrap", () => {
  test("round-trips every field under the same MEK", async () => {
    const mek = await freshMek();
    const salt = generateVaultSalt();
    const original = withPqcSecrets(generateVaultKeyring(), {
      kemSecretB64: encoding.bytesToBase64(new Uint8Array([1, 2, 3, 4])),
      sigSecretB64: encoding.bytesToBase64(new Uint8Array([9, 8, 7])),
    });

    const blob = await wrapKeyring(original, mek, salt, BINDING);
    expect(blob).not.toContain(original.credentials[0].keyB64);

    const reopened = await unwrapKeyring(blob, mek, salt, BINDING);
    expect(reopened).toEqual(original);
  });

  test("a different MEK cannot open it", async () => {
    const salt = generateVaultSalt();
    const blob = await wrapKeyring(generateVaultKeyring(), await freshMek(), salt, BINDING);
    await expect(unwrapKeyring(blob, await freshMek(), salt, BINDING)).rejects.toThrow();
  });

  test("the right MEK with the wrong salt cannot open it", async () => {
    const mek = await freshMek();
    const blob = await wrapKeyring(generateVaultKeyring(), mek, generateVaultSalt(), BINDING);
    await expect(unwrapKeyring(blob, mek, generateVaultSalt(), BINDING)).rejects.toThrow();
  });

  test("the blob cannot be replayed onto another user row", async () => {
    const mek = await freshMek();
    const salt = generateVaultSalt();
    const blob = await wrapKeyring(generateVaultKeyring(), mek, salt, BINDING);

    await expect(
      unwrapKeyring(blob, mek, salt, { ...BINDING, userId: "99999999-0000-0000-0000-000000000000" }),
    ).rejects.toThrow();
  });

  test("the blob cannot be replayed onto another vault key version", async () => {
    const mek = await freshMek();
    const salt = generateVaultSalt();
    const blob = await wrapKeyring(generateVaultKeyring(), mek, salt, BINDING);

    await expect(
      unwrapKeyring(blob, mek, salt, { ...BINDING, vaultKeyVersion: 4 }),
    ).rejects.toThrow();
  });

  test("a tampered byte is rejected rather than decoded", async () => {
    const mek = await freshMek();
    const salt = generateVaultSalt();
    const blob = await wrapKeyring(generateVaultKeyring(), mek, salt, BINDING);

    const bytes = encoding.base64ToBytes(blob);
    bytes[bytes.length - 1] ^= 0xff;
    await expect(
      unwrapKeyring(encoding.bytesToBase64(bytes), mek, salt, BINDING),
    ).rejects.toThrow();
  });

  test("an empty binding is refused before anything is encrypted", async () => {
    const mek = await freshMek();
    const salt = generateVaultSalt();
    const kr = generateVaultKeyring();

    await expect(
      wrapKeyring(kr, mek, salt, { userId: "", vaultKeyVersion: 3 }),
    ).rejects.toThrow(/user id/i);
    await expect(
      wrapKeyring(kr, mek, salt, { userId: BINDING.userId, vaultKeyVersion: 0 }),
    ).rejects.toThrow(/vault key version/i);
  });
});

describe("keyring , the property v3 exists for", () => {
  test("rotating the MEK leaves existing ciphertext readable with no data migration", async () => {
    const salt = generateVaultSalt();
    const oldMek = await freshMek();

    // A vault with real data in it, encrypted under the keyring's data key.
    const keyring = generateVaultKeyring();
    const blob = await wrapKeyring(keyring, oldMek, salt, BINDING);
    const credsKey = await dataKeyFor(keyring, "credentials");
    const txnKey = await dataKeyFor(keyring, "transactions");
    const storedCreds = await encryptString(JSON.stringify({ api_key: "secret-value" }), credsKey);
    const storedTxn = await encryptString(JSON.stringify({ amount_sats: 21000 }), txnKey);

    // Recovery: a genuinely fresh MEK, and NOTHING done to the data rows.
    const newMek = await freshMek();
    const rotated = await rewrapKeyringUnderNewMek({
      ciphertextB64: blob,
      oldMek,
      newMek,
      saltB64: salt,
      binding: BINDING,
    });

    expect(rotated.ciphertextB64).not.toBe(blob);
    expect(rotated.keyring).toEqual(keyring);

    // The same untouched ciphertext still opens.
    const afterCreds = await dataKeyFor(rotated.keyring, "credentials");
    const afterTxn = await dataKeyFor(rotated.keyring, "transactions");
    expect(JSON.parse(await decryptString(storedCreds, afterCreds))).toEqual({
      api_key: "secret-value",
    });
    expect(JSON.parse(await decryptString(storedTxn, afterTxn))).toEqual({ amount_sats: 21000 });
  });

  test("the PQC secrets survive the rotation, because they moved inside the keyring", async () => {
    const salt = generateVaultSalt();
    const oldMek = await freshMek();
    const kemSecretB64 = encoding.bytesToBase64(crypto.getRandomValues(new Uint8Array(64)));
    const sigSecretB64 = encoding.bytesToBase64(crypto.getRandomValues(new Uint8Array(64)));

    const blob = await wrapKeyring(
      withPqcSecrets(generateVaultKeyring(), { kemSecretB64, sigSecretB64 }),
      oldMek,
      salt,
      BINDING,
    );

    const rotated = await rewrapKeyringUnderNewMek({
      ciphertextB64: blob,
      oldMek,
      newMek: await freshMek(),
      saltB64: salt,
      binding: BINDING,
    });

    expect(rotated.keyring.kemSecretB64).toBe(kemSecretB64);
    expect(rotated.keyring.sigSecretB64).toBe(sigSecretB64);
  });

  test("after rotation the old MEK no longer opens the new blob", async () => {
    const salt = generateVaultSalt();
    const oldMek = await freshMek();
    const blob = await wrapKeyring(generateVaultKeyring(), oldMek, salt, BINDING);

    const rotated = await rewrapKeyringUnderNewMek({
      ciphertextB64: blob,
      oldMek,
      newMek: await freshMek(),
      saltB64: salt,
      binding: BINDING,
    });

    await expect(unwrapKeyring(rotated.ciphertextB64, oldMek, salt, BINDING)).rejects.toThrow();
  });

  test("a rotation that throws leaves the stored blob exactly as it was", async () => {
    const salt = generateVaultSalt();
    const oldMek = await freshMek();
    const blob = await wrapKeyring(generateVaultKeyring(), oldMek, salt, BINDING);

    // Wrong old MEK: the unwrap fails, so no new ciphertext is ever produced.
    await expect(
      rewrapKeyringUnderNewMek({
        ciphertextB64: blob,
        oldMek: await freshMek(),
        newMek: await freshMek(),
        saltB64: salt,
        binding: BINDING,
      }),
    ).rejects.toThrow();

    // The value the caller still holds is untouched and still opens.
    await expect(unwrapKeyring(blob, oldMek, salt, BINDING)).resolves.toBeTruthy();
  });
});

describe("keyring , generations", () => {
  test("two generations coexist and both read back after a wrap", async () => {
    const mek = await freshMek();
    const salt = generateVaultSalt();

    const gen1 = generateVaultKeyring();
    const gen2 = addDataKeyGeneration(gen1, "transactions");

    expect(gen2.transactions).toHaveLength(2);
    expect(latestDataKey(gen2, "transactions").generation).toBe(2);
    expect(gen1.transactions).toHaveLength(1); // input was not mutated

    // A row written under each generation.
    const oldRow = await encryptString("written-before", await dataKeyFor(gen2, "transactions", 1));
    const newRow = await encryptString("written-after", await dataKeyFor(gen2, "transactions", 2));

    const reopened = await unwrapKeyring(
      await wrapKeyring(gen2, mek, salt, BINDING),
      mek,
      salt,
      BINDING,
    );
    expect(reopened.transactions).toHaveLength(2);

    // Both rows are readable at the same instant. This is what lets a future
    // rotation sweep stop and resume without stranding a row.
    expect(await decryptString(oldRow, await dataKeyFor(reopened, "transactions", 1))).toBe(
      "written-before",
    );
    expect(await decryptString(newRow, await dataKeyFor(reopened, "transactions", 2))).toBe(
      "written-after",
    );

    // And the generations really are different keys.
    await expect(
      decryptString(oldRow, await dataKeyFor(reopened, "transactions", 2)),
    ).rejects.toThrow();
  });

  test("adding a generation to one kind does not touch the other", () => {
    const kr = generateVaultKeyring();
    const grown = addDataKeyGeneration(kr, "credentials");
    expect(grown.credentials).toHaveLength(2);
    expect(grown.transactions).toEqual(kr.transactions);
  });

  test("a row pointing at a generation the keyring does not have fails by number", () => {
    const kr = generateVaultKeyring();
    expect(() => dataKeyAt(kr, "transactions", 7)).toThrow(/generation 7/);
  });
});

describe("keyring , encoding refuses to produce a wrong answer", () => {
  test("encoding is canonical whatever order the entries were built in", () => {
    const kr = addDataKeyGeneration(generateVaultKeyring(), "credentials");
    const shuffled = { ...kr, credentials: [...kr.credentials].reverse() };
    expect(encodeKeyring(shuffled)).toBe(encodeKeyring(kr));
  });

  test("round-trips through encode and decode unchanged", () => {
    const kr = withPqcSecrets(addDataKeyGeneration(generateVaultKeyring(), "transactions"), {
      kemSecretB64: "AAEC",
      sigSecretB64: null,
    });
    expect(decodeKeyring(encodeKeyring(kr))).toEqual(kr);
  });

  test("rejects an unknown keyring version", () => {
    const wire = JSON.parse(encodeKeyring(generateVaultKeyring()));
    wire.v = 99;
    expect(() => decodeKeyring(JSON.stringify(wire))).toThrow(/version/i);
  });

  test("rejects two entries at the same generation", () => {
    const wire = JSON.parse(encodeKeyring(generateVaultKeyring()));
    wire.txns = [wire.txns[0], { ...wire.txns[0] }];
    expect(() => decodeKeyring(JSON.stringify(wire))).toThrow(/generation 1/);
  });

  test("rejects a data key that is not 32 bytes", () => {
    const wire = JSON.parse(encodeKeyring(generateVaultKeyring()));
    wire.creds[0].k = encoding.bytesToBase64(new Uint8Array(16));
    expect(() => decodeKeyring(JSON.stringify(wire))).toThrow(/32 bytes/);
  });

  test("rejects a keyring with no data keys at all", () => {
    const wire = JSON.parse(encodeKeyring(generateVaultKeyring()));
    wire.creds = [];
    expect(() => decodeKeyring(JSON.stringify(wire))).toThrow(/credentials/);
  });

  test("rejects plaintext that is not a keyring", () => {
    expect(() => decodeKeyring("not json")).toThrow(/JSON/i);
    expect(() => decodeKeyring("[]")).toThrow(/object/i);
  });
});
