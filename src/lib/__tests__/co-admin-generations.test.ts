/**
 * Co-admin v3 consume reads older key generations (OR-T2742).
 *
 * Real grantCoAdminV3 and real loadAdminSubkeysDirect; nothing cryptographic
 * is mocked. Run with:
 *   bunx vitest run src/lib/__tests__/co-admin-generations.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  CoAdminGenerationUnavailableError,
  adminDataKeyFor,
  grantCoAdminV3,
  loadAdminSubkeysDirect,
} from "../co-admin";
import type { CoAdminSupabaseLike, LoadAdminSubkeysParams } from "../co-admin";
import {
  addDataKeyGeneration,
  generateVaultKeyring,
  importDataKey,
  dataKeyAt,
  withPqcSecrets,
  wrapKeyring,
} from "../keyring";
import { decryptString, encoding, encryptString, generateMekBytes, importMekAsHkdf } from "../vault";
import { generateHybridKemKeyPair, generateSigKeyPair } from "../pqc";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const WSKEY = "33333333-3333-4333-8333-333333333333";
const b64 = (b: Uint8Array) => encoding.bytesToBase64(b);

async function setup() {
  const salt = b64(crypto.getRandomValues(new Uint8Array(32)));
  const mek = await importMekAsHkdf(generateMekBytes());
  const sig = generateSigKeyPair();
  const kem = generateHybridKemKeyPair();
  let keyring = withPqcSecrets(generateVaultKeyring(), {
    kemSecretB64: b64(kem.secretKey),
    sigSecretB64: b64(sig.secretKey),
  });
  // Generation 1 exists; the owner writes rows under it, then rotates to 2 and 3.
  const gen1Cred = await importDataKey(dataKeyAt(keyring, "credentials", 1));
  const gen1Tx = await importDataKey(dataKeyAt(keyring, "transactions", 1));
  keyring = addDataKeyGeneration(addDataKeyGeneration(keyring, "credentials"), "credentials");
  keyring = addDataKeyGeneration(keyring, "transactions");
  const ciphertext = await wrapKeyring(keyring, mek, salt, { userId: OWNER, keyringEpoch: 1 });

  const adminMek = await importMekAsHkdf(generateMekBytes());
  const adminSalt = b64(crypto.getRandomValues(new Uint8Array(32)));
  const adminKem = generateHybridKemKeyPair();
  const adminKeyring = withPqcSecrets(generateVaultKeyring(), {
    kemSecretB64: b64(adminKem.secretKey),
    sigSecretB64: b64(generateSigKeyPair().secretKey),
  });
  const adminCt = await wrapKeyring(adminKeyring, adminMek, adminSalt, { userId: ADMIN, keyringEpoch: 1 });

  let row: Record<string, unknown> = {};
  const supabase = {
    from: (table: string) => ({
      insert: (r: Record<string, unknown>) => {
        if (table === "wrapped_data_keys") row = r;
        return Promise.resolve({ data: [r], error: null });
      },
    }),
    rpc: () => Promise.resolve({ data: WSKEY, error: null }),
  } as unknown as CoAdminSupabaseLike;
  await grantCoAdminV3({
    ownerUserId: OWNER,
    ownerSaltB64: salt,
    vaultMek: mek,
    ownerKeyringCiphertext: ciphertext,
    ownerKeyringEpoch: 1,
    targetUserId: ADMIN,
    targetKemPubB64: b64(adminKem.publicKey),
    existingKeyId: WSKEY,
    supabase,
  });

  const subkeys = await loadAdminSubkeysDirect({
    grantId: row.id as string,
    ownerUserId: OWNER,
    wrappedCakB64: row.wrapped_cak as string,
    coadminKeyringCiphertextB64: row.coadmin_keyring_ciphertext as string,
    kemSecretWrapped: null,
    adminKeyringCiphertext: adminCt,
    adminKeyringEpoch: 1,
    adminMek,
    adminSaltB64: adminSalt,
    grantSigB64: row.grant_sig as string,
    ownerSigPubB64: b64(sig.publicKey),
    granteeUserId: ADMIN,
    ownerWorkspaceKeyId: WSKEY,
  } as unknown as LoadAdminSubkeysParams);
  return { subkeys, gen1Cred, gen1Tx };
}

describe("v3 consume reads older generations", () => {
  it("opens a row written under generation 1 after the keyring holds 2 and 3", async () => {
    const { subkeys, gen1Cred, gen1Tx } = await setup();
    const credRow = await encryptString("old credentials", gen1Cred);
    const txRow = await encryptString("old transaction", gen1Tx);

    expect(await decryptString(credRow, adminDataKeyFor(subkeys, "credentials", 1))).toBe("old credentials");
    expect(await decryptString(txRow, adminDataKeyFor(subkeys, "transactions", 1))).toBe("old transaction");

    // The single-key fields remain the LATEST generation, which cannot open gen 1.
    await expect(decryptString(credRow, subkeys.credentialsKey)).rejects.toBeDefined();
    // Omitting the generation gives that same latest key.
    expect(adminDataKeyFor(subkeys, "credentials")).toBe(subkeys.credentialsKey);
    expect(subkeys.generations?.credentials.size).toBe(3);
  });

  it("refuses a generation the keyring does not hold, naming it", () => {
    return setup().then(({ subkeys }) => {
      let caught: unknown;
      try {
        adminDataKeyFor(subkeys, "credentials", 7);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(CoAdminGenerationUnavailableError);
      expect((caught as Error).message).toContain("7");
      expect((caught as CoAdminGenerationUnavailableError).generation).toBe(7);
      // transactions only holds 1 and 2: generation 3 is absent for that kind.
      expect(() => adminDataKeyFor(subkeys, "transactions", 3)).toThrow(/generation 3/);
    });
  });
});
