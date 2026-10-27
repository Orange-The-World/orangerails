/**
 * Envelope v3, construction (d): the grant end to end (OR-T0769).
 *
 * WHAT THIS FILE IS FOR. The primitives (the projection, the seal, the CAK
 * wrap) are tested one at a time elsewhere. This file tests the promise they
 * exist to keep: a co-admin grant made BEFORE the owner recovers their vault
 * must still open AFTER it, with no re-grant. A v2 grant cannot keep that
 * promise. Its blob holds HKDF subkeys of the owner's master key, and a
 * recovery replaces that key with a fresh random one.
 *
 * HOW. The grant and the consume path are the real functions, run against
 * keys built with the product's own generators, so a pass cannot come from a
 * test agreeing with a mistake in its own fixture. Two properties are checked
 * FUNCTIONALLY, by encrypting with the owner's key and decrypting with the
 * admin's, never by comparing key objects.
 *
 * WHAT IS DELIBERATELY NOT MOCKED. Nothing about the cryptography. The two
 * decrypt steps of a v3 consume (unwrapCoAdminKey and openCoAdminKeyring) are
 * wrapped in spies that still call the real implementation, only so a test can
 * prove they were NOT reached when a signature is bad.
 *
 * Run with:
 *   bunx vitest run src/lib/__tests__/co-admin-construction-d.test.ts
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../co-admin-keyring", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../co-admin-keyring")>();
  return {
    ...actual,
    unwrapCoAdminKey: vi.fn(actual.unwrapCoAdminKey),
    openCoAdminKeyring: vi.fn(actual.openCoAdminKeyring),
  };
});

import {
  grantCoAdmin,
  grantCoAdminV3,
  loadAdminSubkeysDirect,
  unwrapBlob64,
  wrapBlob64,
} from "../co-admin";
import type {
  AdminGrantMaterial,
  AdminSubkeys,
  CoAdminSupabaseLike,
  LoadAdminSubkeysParams,
} from "../co-admin";
import {
  COADMIN_CAK_ALGORITHM,
  openCoAdminKeyring,
  unwrapCoAdminKey,
} from "../co-admin-keyring";
import {
  addDataKeyGeneration,
  generateVaultKeyring,
  importDataKey,
  latestDataKey,
  rewrapKeyringUnderNewMek,
  unwrapKeyring,
  withPqcSecrets,
  wrapKeyring,
} from "../keyring";
import type { VaultKeyring } from "../keyring";
import {
  createVaultVerifier,
  decryptString,
  deriveKek,
  encoding,
  encryptString,
  generateMekBytes,
  importMekAsHkdf,
  wrapMekBytes,
} from "../vault";
import {
  HKDF_CONTEXTS,
  derivePqcSecretWrapKey,
  deriveSubkey,
  deriveVerifierKey,
} from "../key-derivation";
import { buildPqcKeyMaterial } from "../pqc-lifecycle";
import {
  HYBRID_KEM_CIPHERTEXT_BYTES,
  generateHybridKemKeyPair,
  generateSigKeyPair,
  hybridEncapsulate,
} from "../pqc";
import { signMemberGrant } from "../member-grant";

// Argon2id runs inside the v2 owner fixture and inside the password check. The
// default 5s timeout would read as a failure of the thing under test.
const ARGON2_TIMEOUT_MS = 120_000;

const OWNER_PASSWORD = "co-admin-construction-d-7!";
const OWNER_USER_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN_USER_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_KEY_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_USER_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_WORKSPACE_KEY_ID = "55555555-5555-4555-8555-555555555555";

const SAMPLE = "a value the owner encrypted";

beforeEach(() => {
  vi.mocked(unwrapCoAdminKey).mockClear();
  vi.mocked(openCoAdminKeyring).mockClear();
});

// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------

function b64(bytes: Uint8Array): string {
  return encoding.bytesToBase64(bytes);
}

function randomSaltB64(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}

async function freshMek(): Promise<CryptoKey> {
  return importMekAsHkdf(generateMekBytes());
}

/** Flip one bit of one byte of a base64 value, so the change is never a no-op. */
function flipByte(valueB64: string, index: number): string {
  const bytes = encoding.base64ToBytes(valueB64);
  bytes[index] ^= 0x01;
  return b64(bytes);
}

/**
 * Do these two keys open the same data? Answered by doing it: encrypt with the
 * writer, decrypt with the reader. A reader that fails to decrypt is a "no",
 * not an exception, so the caller can assert either outcome.
 */
async function opens(writer: CryptoKey, reader: CryptoKey): Promise<boolean> {
  const sealed = await encryptString(SAMPLE, writer);
  try {
    return (await decryptString(sealed, reader)) === SAMPLE;
  } catch {
    return false;
  }
}

/** The owner's own data keys, as the owner's data path would import them. */
async function ownerDataKeys(keyring: VaultKeyring): Promise<{
  credentials: CryptoKey;
  transactions: CryptoKey;
}> {
  return {
    credentials: await importDataKey(latestDataKey(keyring, "credentials")),
    transactions: await importDataKey(latestDataKey(keyring, "transactions")),
  };
}

// ------------------------------------------------------------------
// A recording Supabase stub. A select or a delete during a grant is a failure:
// the grant flow has no business making one.
// ------------------------------------------------------------------

type StoredGrant = Record<string, unknown>;

interface Recorder {
  calls: string[];
  inserts: { table: string; row: StoredGrant }[];
}

function recordingSupabase(): { supabase: CoAdminSupabaseLike; recorder: Recorder } {
  const recorder: Recorder = { calls: [], inserts: [] };

  const supabase = {
    from(table: string) {
      return {
        select(columns: string) {
          recorder.calls.push(`select ${table}(${columns})`);
          throw new Error(`unexpected select on ${table} during grant`);
        },
        insert(row: StoredGrant) {
          recorder.calls.push(`insert ${table}`);
          recorder.inserts.push({ table, row });
          return Promise.resolve({ data: [row], error: null });
        },
        delete() {
          recorder.calls.push(`delete ${table}`);
          throw new Error(`unexpected delete on ${table} during grant`);
        },
      };
    },
    rpc(fn: string) {
      recorder.calls.push(`rpc ${fn}`);
      return Promise.resolve({ data: WORKSPACE_KEY_ID, error: null });
    },
  };

  return { supabase: supabase as unknown as CoAdminSupabaseLike, recorder };
}

function storedGrant(recorder: Recorder): StoredGrant {
  const written = recorder.inserts.find((i) => i.table === "wrapped_data_keys");
  if (!written) throw new Error("no wrapped_data_keys row was written");
  return written.row;
}

function str(row: StoredGrant, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new Error(`stored grant has no text column ${column}`);
  return value;
}

// ------------------------------------------------------------------
// Owners
// ------------------------------------------------------------------

interface V3Owner {
  mek: CryptoKey;
  saltB64: string;
  keyring: VaultKeyring;
  keyringCiphertext: string;
  keyringEpoch: number;
  sigPublicKeyB64: string;
}

/** An owner whose vault holds a keyring, with both PQC secrets inside it. */
async function buildV3Owner(prepare?: (keyring: VaultKeyring) => VaultKeyring): Promise<V3Owner> {
  const saltB64 = randomSaltB64();
  const mek = await freshMek();
  const sig = generateSigKeyPair();
  const kem = generateHybridKemKeyPair();

  let keyring = withPqcSecrets(generateVaultKeyring(), {
    kemSecretB64: b64(kem.secretKey),
    sigSecretB64: b64(sig.secretKey),
  });
  if (prepare) keyring = prepare(keyring);

  const keyringEpoch = 1;
  const keyringCiphertext = await wrapKeyring(keyring, mek, saltB64, {
    userId: OWNER_USER_ID,
    keyringEpoch,
  });
  return {
    mek,
    saltB64,
    keyring,
    keyringCiphertext,
    keyringEpoch,
    sigPublicKeyB64: b64(sig.publicKey),
  };
}

interface V2Owner {
  mek: CryptoKey;
  saltB64: string;
  encMekCiphertext: string;
  verifierCiphertext: string;
  sigSecretWrapped: string;
  sigPublicKeyB64: string;
}

/**
 * A key-version-2 owner built the way setupVault and ensurePqcKeypairs build
 * one: a random MEK wrapped by the Argon2id KEK, PQC secrets wrapped under a
 * subkey of that MEK. Built once and reused, because Argon2id is the slow part.
 */
async function buildV2Owner(): Promise<V2Owner> {
  const saltB64 = randomSaltB64();
  const mekRaw = generateMekBytes();
  const mek = await importMekAsHkdf(mekRaw);
  const kek = await deriveKek(OWNER_PASSWORD, saltB64);
  const encMekCiphertext = await wrapMekBytes(mekRaw, kek);
  const verifierCiphertext = await createVaultVerifier(await deriveVerifierKey(mek, saltB64));
  const pqc = await buildPqcKeyMaterial(await derivePqcSecretWrapKey(mek, saltB64));
  return {
    mek,
    saltB64,
    encMekCiphertext,
    verifierCiphertext,
    sigSecretWrapped: pqc.sig_secret_wrapped,
    sigPublicKeyB64: pqc.sig_public_key,
  };
}

let cachedV2Owner: Promise<V2Owner> | undefined;
function getV2Owner(): Promise<V2Owner> {
  cachedV2Owner ??= buildV2Owner();
  return cachedV2Owner;
}

// ------------------------------------------------------------------
// Admins (the recipients)
// ------------------------------------------------------------------

interface AdminVault {
  mek: CryptoKey;
  saltB64: string;
  /** What an owner wraps a grant to. */
  kemPublicKeyB64: string;
  /** A legacy vault keeps the KEM secret in its own wrapped column. */
  kemSecretWrapped: string | null;
  /** A keyring vault keeps it inside the keyring. */
  keyringCiphertext: string | null;
  keyringEpoch: number | null;
}

interface KeyringAdmin extends AdminVault {
  kemSecretKey: Uint8Array;
}

async function buildLegacyAdmin(): Promise<AdminVault> {
  const saltB64 = randomSaltB64();
  const mek = await freshMek();
  const pqc = await buildPqcKeyMaterial(await derivePqcSecretWrapKey(mek, saltB64));
  return {
    mek,
    saltB64,
    kemPublicKeyB64: pqc.kem_public_key,
    kemSecretWrapped: pqc.kem_secret_wrapped,
    keyringCiphertext: null,
    keyringEpoch: null,
  };
}

async function buildKeyringAdmin(): Promise<KeyringAdmin> {
  const saltB64 = randomSaltB64();
  const mek = await freshMek();
  const kem = generateHybridKemKeyPair();
  const sig = generateSigKeyPair();
  const keyring = withPqcSecrets(generateVaultKeyring(), {
    kemSecretB64: b64(kem.secretKey),
    sigSecretB64: b64(sig.secretKey),
  });
  const keyringEpoch = 1;
  const keyringCiphertext = await wrapKeyring(keyring, mek, saltB64, {
    userId: ADMIN_USER_ID,
    keyringEpoch,
  });
  return {
    mek,
    saltB64,
    kemPublicKeyB64: b64(kem.publicKey),
    kemSecretWrapped: null,
    keyringCiphertext,
    keyringEpoch,
    kemSecretKey: kem.secretKey,
  };
}

// ------------------------------------------------------------------
// Grants, produced by the real code
// ------------------------------------------------------------------

async function grantV3(
  owner: V3Owner,
  admin: AdminVault,
): Promise<{ row: StoredGrant; recorder: Recorder }> {
  const { supabase, recorder } = recordingSupabase();
  await grantCoAdminV3({
    ownerUserId: OWNER_USER_ID,
    ownerSaltB64: owner.saltB64,
    vaultMek: owner.mek,
    ownerKeyringCiphertext: owner.keyringCiphertext,
    ownerKeyringEpoch: owner.keyringEpoch,
    targetUserId: ADMIN_USER_ID,
    targetKemPubB64: admin.kemPublicKeyB64,
    existingKeyId: WORKSPACE_KEY_ID,
    supabase,
  });
  return { row: storedGrant(recorder), recorder };
}

/** The public entry point. Reports what happened instead of asserting. */
async function runGrantCoAdmin(
  owner: V2Owner,
  admin: AdminVault,
  overrides: Record<string, unknown> = {},
): Promise<{ recorder: Recorder; error: unknown }> {
  const { supabase, recorder } = recordingSupabase();
  const params = {
    ownerUserId: OWNER_USER_ID,
    ownerSaltB64: owner.saltB64,
    ownerPassword: OWNER_PASSWORD,
    ownerVerifierCiphertext: owner.verifierCiphertext,
    ownerKeyVersion: 2,
    ownerEncMekCiphertext: owner.encMekCiphertext,
    vaultMek: owner.mek,
    ownerSigSecretWrapped: owner.sigSecretWrapped,
    targetUserId: ADMIN_USER_ID,
    targetKemPubB64: admin.kemPublicKeyB64,
    existingKeyId: null,
    supabase,
    ...overrides,
  } as unknown as Parameters<typeof grantCoAdmin>[0];

  try {
    await grantCoAdmin(params);
    return { recorder, error: null };
  } catch (error) {
    return { recorder, error };
  }
}

// ------------------------------------------------------------------
// Consuming a stored grant, the way the app does after it reads the row
// ------------------------------------------------------------------

function materialOf(row: StoredGrant): AdminGrantMaterial {
  if (typeof row.wrapped_cak === "string") {
    return {
      grantId: str(row, "id"),
      ownerUserId: OWNER_USER_ID,
      wrappedCakB64: str(row, "wrapped_cak"),
      coadminKeyringCiphertextB64: str(row, "coadmin_keyring_ciphertext"),
    };
  }
  return { wrappedCiphertextB64: str(row, "wrapped_ciphertext") };
}

function adminSide(admin: AdminVault) {
  return {
    kemSecretWrapped: admin.kemSecretWrapped,
    adminKeyringCiphertext: admin.keyringCiphertext,
    adminKeyringEpoch: admin.keyringEpoch,
    adminMek: admin.mek,
    adminSaltB64: admin.saltB64,
  };
}

async function consume(
  row: StoredGrant,
  admin: AdminVault,
  ownerSigPubB64: string,
  overrides: Record<string, unknown> = {},
): Promise<AdminSubkeys> {
  const params = {
    ...materialOf(row),
    ...adminSide(admin),
    grantSigB64: str(row, "grant_sig"),
    ownerSigPubB64,
    granteeUserId: ADMIN_USER_ID,
    ownerWorkspaceKeyId: WORKSPACE_KEY_ID,
    ...overrides,
  } as unknown as LoadAdminSubkeysParams;
  return loadAdminSubkeysDirect(params);
}

// ==================================================================
// 1. A v3 grant survives the owner's vault recovery
// ==================================================================

describe("a v3 grant survives the owner's vault recovery", () => {
  it("opens data written before and after the recovery, from the same stored row", async () => {
    const owner = await buildV3Owner();
    const admin = await buildKeyringAdmin();
    const { row } = await grantV3(owner, admin);

    // Data the owner wrote BEFORE the recovery, under the keys they hold now.
    const before = await ownerDataKeys(owner.keyring);
    const credentialsBefore = await encryptString("credentials written before", before.credentials);
    const transactionsBefore = await encryptString(
      "transactions written before",
      before.transactions,
    );

    // The recovery: a fresh random master key replaces the old one and the
    // keyring is re-wrapped under it. The stored grant row is NOT touched, and
    // nothing here re-grants.
    const recoveredMek = await freshMek();
    const recovered = await rewrapKeyringUnderNewMek({
      ciphertextB64: owner.keyringCiphertext,
      oldMek: owner.mek,
      newMek: recoveredMek,
      saltB64: owner.saltB64,
      binding: { userId: OWNER_USER_ID, keyringEpoch: owner.keyringEpoch },
    });
    expect(recovered.keyringEpoch).toBe(owner.keyringEpoch + 1);

    // The owner, after recovery, reads their keyring under the new master key.
    const reopened = await unwrapKeyring(recovered.ciphertextB64, recoveredMek, owner.saltB64, {
      userId: OWNER_USER_ID,
      keyringEpoch: recovered.keyringEpoch,
    });
    const after = await ownerDataKeys(reopened);

    // The admin opens the SAME row, and reads both old and new data.
    const subkeys = await consume(row, admin, owner.sigPublicKeyB64);
    expect(await decryptString(credentialsBefore, subkeys.credentialsKey)).toBe(
      "credentials written before",
    );
    expect(await decryptString(transactionsBefore, subkeys.transactionsKey)).toBe(
      "transactions written before",
    );
    expect(await opens(after.credentials, subkeys.credentialsKey)).toBe(true);
    expect(await opens(after.transactions, subkeys.transactionsKey)).toBe(true);
  });

  it("control: subkeys of the old master key cannot read what a recovered vault writes", async () => {
    // The v2 blob holds HKDF subkeys of the master key of the moment. This is
    // what a recovery does to them, and it is why the test above is not a
    // vacuous pass: the same check returns false when the key really moved.
    const saltB64 = randomSaltB64();
    const oldMek = await freshMek();
    const recoveredMek = await freshMek();

    const frozen = await deriveSubkey(oldMek, HKDF_CONTEXTS.ORANGERAILS_CREDENTIALS_V1, saltB64);
    const current = await deriveSubkey(
      recoveredMek,
      HKDF_CONTEXTS.ORANGERAILS_CREDENTIALS_V1,
      saltB64,
    );

    expect(await opens(frozen, frozen)).toBe(true);
    expect(await opens(current, frozen)).toBe(false);
  });

  it("stores a v3 row: the grant id, the wrapped key and the sealed keyring, and no v2 blob", async () => {
    const owner = await buildV3Owner();
    const admin = await buildKeyringAdmin();
    const { row, recorder } = await grantV3(owner, admin);

    expect(Object.keys(row).sort()).toEqual([
      "algorithm",
      "coadmin_keyring_ciphertext",
      "data_key_id",
      "grant_sig",
      "id",
      "recipient_user_id",
      "wrapped_cak",
    ]);
    expect(row.algorithm).toBe(COADMIN_CAK_ALGORITHM);
    expect(row.data_key_id).toBe(WORKSPACE_KEY_ID);
    expect(row.recipient_user_id).toBe(ADMIN_USER_ID);
    expect(row).not.toHaveProperty("wrapped_ciphertext");

    // The list row goes first and the key row second, so a stop between them
    // leaves the evidence and not the access.
    expect(recorder.calls).toEqual(["insert workspace_admins", "insert wrapped_data_keys"]);
  });

  it("gives every grant its own id and its own key", async () => {
    const owner = await buildV3Owner();
    const admin = await buildKeyringAdmin();
    const first = (await grantV3(owner, admin)).row;
    const second = (await grantV3(owner, admin)).row;

    expect(str(first, "id")).not.toBe(str(second, "id"));
    expect(str(first, "wrapped_cak")).not.toBe(str(second, "wrapped_cak"));
    expect(str(first, "coadmin_keyring_ciphertext")).not.toBe(
      str(second, "coadmin_keyring_ciphertext"),
    );
  });

  it("seals the data keys and none of the owner's secrets", async () => {
    const owner = await buildV3Owner();
    const admin = await buildKeyringAdmin();
    const { row } = await grantV3(owner, admin);

    // Open the sealed keyring the way the admin does, then look at what is in
    // it. The owner's signing secret in there would let an admin sign grants in
    // the owner's name, so "may read my data" would become "is me".
    const cak = await unwrapCoAdminKey(encoding.base64ToBytes(str(row, "wrapped_cak")), admin.kemSecretKey);
    const projection = await openCoAdminKeyring(str(row, "coadmin_keyring_ciphertext"), cak, {
      ownerUserId: OWNER_USER_ID,
      grantId: str(row, "id"),
    });

    const text = JSON.stringify(projection);
    expect(owner.keyring.kemSecretB64).toBeTruthy();
    expect(owner.keyring.sigSecretB64).toBeTruthy();
    expect(text).not.toContain(owner.keyring.kemSecretB64 as string);
    expect(text).not.toContain(owner.keyring.sigSecretB64 as string);
    expect(projection.credentials.map((e) => e.keyB64)).toEqual(
      owner.keyring.credentials.map((e) => e.keyB64),
    );
    expect(projection.transactions.map((e) => e.keyB64)).toEqual(
      owner.keyring.transactions.map((e) => e.keyB64),
    );
  });
});

// ==================================================================
// 5. Mixed versions open in every direction
// ==================================================================

describe("every pairing of grant version and admin vault version opens", () => {
  const PAIRINGS = [
    { grant: "v2", admin: "legacy" },
    { grant: "v2", admin: "keyring" },
    { grant: "v3", admin: "legacy" },
    { grant: "v3", admin: "keyring" },
  ] as const;

  for (const pairing of PAIRINGS) {
    it(
      `a ${pairing.admin} vault opens a ${pairing.grant} grant`,
      async () => {
        const admin =
          pairing.admin === "legacy" ? await buildLegacyAdmin() : await buildKeyringAdmin();

        let row: StoredGrant;
        let ownerSigPubB64: string;
        let ownerKeys: { credentials: CryptoKey; transactions: CryptoKey };

        if (pairing.grant === "v2") {
          const owner = await getV2Owner();
          const run = await runGrantCoAdmin(owner, admin);
          expect(run.error).toBeNull();
          row = storedGrant(run.recorder);
          expect(row).toHaveProperty("wrapped_ciphertext");
          expect(row).not.toHaveProperty("wrapped_cak");
          ownerSigPubB64 = owner.sigPublicKeyB64;
          // A v2 owner's data path is the HKDF subkeys of its master key.
          ownerKeys = {
            credentials: await deriveSubkey(
              owner.mek,
              HKDF_CONTEXTS.ORANGERAILS_CREDENTIALS_V1,
              owner.saltB64,
            ),
            transactions: await deriveSubkey(
              owner.mek,
              HKDF_CONTEXTS.ORANGERAILS_TRANSACTIONS_V1,
              owner.saltB64,
            ),
          };
        } else {
          const owner = await buildV3Owner();
          row = (await grantV3(owner, admin)).row;
          expect(row).toHaveProperty("wrapped_cak");
          expect(row).not.toHaveProperty("wrapped_ciphertext");
          ownerSigPubB64 = owner.sigPublicKeyB64;
          ownerKeys = await ownerDataKeys(owner.keyring);
        }

        const subkeys = await consume(row, admin, ownerSigPubB64);

        expect(await opens(ownerKeys.credentials, subkeys.credentialsKey)).toBe(true);
        expect(await opens(ownerKeys.transactions, subkeys.transactionsKey)).toBe(true);
        // The two keys are different keys: a credentials value does not open
        // under the transactions key, so the two checks above are not the same
        // check twice.
        expect(await opens(ownerKeys.credentials, subkeys.transactionsKey)).toBe(false);
      },
      ARGON2_TIMEOUT_MS,
    );
  }
});

// ==================================================================
// The public entry point chooses the envelope from the vault
// ==================================================================

describe("grantCoAdmin chooses the envelope from what the vault holds", () => {
  /** The v2 owner's vault, given a keyring under the same master key. */
  async function withKeyring() {
    const owner = await getV2Owner();
    const sig = generateSigKeyPair();
    const kem = generateHybridKemKeyPair();
    const keyring = withPqcSecrets(generateVaultKeyring(), {
      kemSecretB64: b64(kem.secretKey),
      sigSecretB64: b64(sig.secretKey),
    });
    const keyringEpoch = 1;
    const keyringCiphertext = await wrapKeyring(keyring, owner.mek, owner.saltB64, {
      userId: OWNER_USER_ID,
      keyringEpoch,
    });
    return { owner, keyring, keyringEpoch, keyringCiphertext, sigPublicKeyB64: b64(sig.publicKey) };
  }

  it(
    "grants under v3 when the vault holds a keyring, and the row can be opened",
    async () => {
      const { owner, keyring, keyringEpoch, keyringCiphertext, sigPublicKeyB64 } =
        await withKeyring();
      const admin = await buildKeyringAdmin();

      const run = await runGrantCoAdmin(owner, admin, {
        ownerKeyringCiphertext: keyringCiphertext,
        ownerKeyringEpoch: keyringEpoch,
        ownerSigSecretWrapped: null,
      });

      expect(run.error).toBeNull();
      // The server allocates the workspace key id BEFORE the signature is made,
      // then the list row, then the key row.
      expect(run.recorder.calls).toEqual([
        "rpc allocate_workspace_key",
        "insert workspace_admins",
        "insert wrapped_data_keys",
      ]);
      const row = storedGrant(run.recorder);
      expect(row).toHaveProperty("wrapped_cak");
      expect(row).not.toHaveProperty("wrapped_ciphertext");

      const subkeys = await consume(row, admin, sigPublicKeyB64);
      const ownerKeys = await ownerDataKeys(keyring);
      expect(await opens(ownerKeys.credentials, subkeys.credentialsKey)).toBe(true);
      expect(await opens(ownerKeys.transactions, subkeys.transactionsKey)).toBe(true);
    },
    ARGON2_TIMEOUT_MS,
  );

  it(
    "stops with nothing allocated or written when the keyring epoch is missing",
    async () => {
      const { owner, keyringCiphertext } = await withKeyring();
      const admin = await buildKeyringAdmin();

      const run = await runGrantCoAdmin(owner, admin, {
        ownerKeyringCiphertext: keyringCiphertext,
        ownerKeyringEpoch: null,
        ownerSigSecretWrapped: null,
      });

      expect(run.error).toBeInstanceOf(Error);
      expect((run.error as Error).message).toMatch(/keyring could not be read/);
      expect(run.recorder.calls).toEqual([]);
    },
    ARGON2_TIMEOUT_MS,
  );

  it(
    "checks the owner's password before it touches a keyring grant",
    async () => {
      const { owner, keyringEpoch, keyringCiphertext } = await withKeyring();
      const admin = await buildKeyringAdmin();

      const run = await runGrantCoAdmin(owner, admin, {
        ownerPassword: "not-the-password-9!",
        ownerKeyringCiphertext: keyringCiphertext,
        ownerKeyringEpoch: keyringEpoch,
        ownerSigSecretWrapped: null,
      });

      expect(run.error).toBeInstanceOf(Error);
      expect((run.error as Error).message).toMatch(/password is not correct/);
      expect(run.recorder.calls).toEqual([]);
    },
    ARGON2_TIMEOUT_MS,
  );
});

// ==================================================================
// 6. The signature is checked before anything is decrypted
// ==================================================================

describe("the owner's signature is checked before anything is decrypted", () => {
  let owner: V3Owner;
  let admin: KeyringAdmin;
  let row: StoredGrant;
  let otherRow: StoredGrant;

  beforeAll(async () => {
    owner = await buildV3Owner();
    admin = await buildKeyringAdmin();
    row = (await grantV3(owner, admin)).row;
    otherRow = (await grantV3(owner, admin)).row;
  });

  /** Refused, and neither decrypt step was ever reached. */
  async function expectRefusedBeforeDecryption(attempt: Promise<unknown>, message: RegExp) {
    await expect(attempt).rejects.toThrow(message);
    expect(unwrapCoAdminKey).not.toHaveBeenCalled();
    expect(openCoAdminKeyring).not.toHaveBeenCalled();
  }

  it("control: an untampered grant does reach both decrypt steps", async () => {
    // Without this, every "not called" below would also pass against a spy
    // that observes nothing.
    await consume(row, admin, owner.sigPublicKeyB64);
    expect(unwrapCoAdminKey).toHaveBeenCalledTimes(1);
    expect(openCoAdminKeyring).toHaveBeenCalledTimes(1);
  });

  it("refuses a missing signature", async () => {
    await expectRefusedBeforeDecryption(
      consume(row, admin, owner.sigPublicKeyB64, { grantSigB64: null }),
      /signature missing/,
    );
  });

  it("refuses an empty signature", async () => {
    await expectRefusedBeforeDecryption(
      consume(row, admin, owner.sigPublicKeyB64, { grantSigB64: "" }),
      /signature missing/,
    );
  });

  it("refuses a signature that was altered", async () => {
    await expectRefusedBeforeDecryption(
      consume(row, admin, owner.sigPublicKeyB64, {
        grantSigB64: flipByte(str(row, "grant_sig"), 0),
      }),
      /signature invalid/,
    );
  });

  it("refuses a signature made by someone other than the owner", async () => {
    const stranger = b64(generateSigKeyPair().publicKey);
    await expectRefusedBeforeDecryption(
      consume(row, admin, stranger),
      /signature invalid/,
    );
  });

  it("refuses a wrapped key that was swapped for another grant's after signing", async () => {
    await expectRefusedBeforeDecryption(
      consume(row, admin, owner.sigPublicKeyB64, {
        wrappedCakB64: str(otherRow, "wrapped_cak"),
      }),
      /signature invalid/,
    );
  });

  it("refuses a grant presented as if it were made for someone else", async () => {
    await expectRefusedBeforeDecryption(
      consume(row, admin, owner.sigPublicKeyB64, { granteeUserId: OTHER_USER_ID }),
      /signature invalid/,
    );
  });

  it("refuses a grant presented against a different workspace key", async () => {
    await expectRefusedBeforeDecryption(
      consume(row, admin, owner.sigPublicKeyB64, { ownerWorkspaceKeyId: OTHER_WORKSPACE_KEY_ID }),
      /signature invalid/,
    );
  });

  it("refuses when the owner's public key is not supplied", async () => {
    await expectRefusedBeforeDecryption(
      consume(row, admin, "", {}),
      /binding fields missing/,
    );
  });

  it("refuses a shape that is neither a v2 blob nor a v3 wrapped key", async () => {
    const params = {
      ...adminSide(admin),
      grantSigB64: str(row, "grant_sig"),
      ownerSigPubB64: owner.sigPublicKeyB64,
      granteeUserId: ADMIN_USER_ID,
      ownerWorkspaceKeyId: WORKSPACE_KEY_ID,
    } as unknown as LoadAdminSubkeysParams;

    await expectRefusedBeforeDecryption(
      loadAdminSubkeysDirect(params),
      /neither a v2 subkey blob nor a v3 wrapped key/,
    );
  });

  it("a tampered sealed keyring is not covered by the signature, and the seal itself refuses it", async () => {
    // The sealed keyring is deliberately outside the signed set: without the
    // CAK it is inert, and its integrity comes from AES-GCM bound to the owner
    // and the grant id. So the signature check PASSES here and the refusal
    // comes one step later, from the seal.
    await expect(
      consume(row, admin, owner.sigPublicKeyB64, {
        coadminKeyringCiphertextB64: flipByte(str(row, "coadmin_keyring_ciphertext"), 20),
      }),
    ).rejects.toBeTruthy();
    expect(unwrapCoAdminKey).toHaveBeenCalledTimes(1);
    expect(openCoAdminKeyring).toHaveBeenCalledTimes(1);
  });
});

// ==================================================================
// 7. Blob shapes and key generations
// ==================================================================

describe("blob shapes and key generations", () => {
  /**
   * The same wire format as wrapBlob64 with the structure check left out, so a
   * malformed blob can be built and handed to the consume side. The producer
   * refuses to build one, which is exactly why the consumer's own refusal needs
   * a test of its own.
   */
  async function wrapWithoutStructureCheck(
    blob: Uint8Array,
    recipientPublicKey: Uint8Array,
  ): Promise<Uint8Array> {
    const { ciphertext, sharedSecret } = hybridEncapsulate(recipientPublicKey);
    const aesKey = await crypto.subtle.importKey(
      "raw",
      sharedSecret as BufferSource,
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, aesKey, blob as BufferSource),
    );
    const out = new Uint8Array(ciphertext.length + iv.length + sealed.length);
    out.set(ciphertext, 0);
    out.set(iv, ciphertext.length);
    out.set(sealed, ciphertext.length + iv.length);
    return out;
  }

  /** A v2 style row, signed by a real owner key, around the given wrapped bytes. */
  async function signedV2Row(
    wrapped: Uint8Array,
    signer: { secretKey: Uint8Array },
  ): Promise<StoredGrant> {
    const wrappedCiphertextB64 = b64(wrapped);
    const { signature } = await signMemberGrant(signer.secretKey, {
      memberUserId: ADMIN_USER_ID,
      workspaceKeyId: WORKSPACE_KEY_ID,
      wrappedMekCiphertextB64: wrappedCiphertextB64,
    });
    return { wrapped_ciphertext: wrappedCiphertextB64, grant_sig: signature };
  }

  for (const length of [2, 32, 64, 96]) {
    it(`wrapBlob64 round trips a ${length} byte blob`, async () => {
      const kem = generateHybridKemKeyPair();
      const blob = crypto.getRandomValues(new Uint8Array(length));
      const wrapped = await wrapBlob64(blob, kem.publicKey);
      expect(Array.from(await unwrapBlob64(wrapped, kem.secretKey))).toEqual(Array.from(blob));
    });
  }

  for (const length of [0, 1, 63]) {
    it(`wrapBlob64 refuses a ${length} byte blob, which cannot be two equal halves`, async () => {
      const kem = generateHybridKemKeyPair();
      await expect(wrapBlob64(new Uint8Array(length), kem.publicKey)).rejects.toThrow(
        /two equal length subkeys/,
      );
    });
  }

  const FLOOR = HYBRID_KEM_CIPHERTEXT_BYTES + 12 + 16;
  for (const length of [0, FLOOR - 1, FLOOR]) {
    it(`unwrapBlob64 refuses ${length} bytes, which leaves no room for a plaintext`, async () => {
      const kem = generateHybridKemKeyPair();
      await expect(unwrapBlob64(new Uint8Array(length), kem.secretKey)).rejects.toThrow(
        /must be longer than/,
      );
    });
  }

  it("opens a signed v2 grant of two 16 byte halves as two working, different keys", async () => {
    const admin = await buildLegacyAdmin();
    const signer = generateSigKeyPair();
    const blob = crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await wrapBlob64(blob, encoding.base64ToBytes(admin.kemPublicKeyB64));
    const row = await signedV2Row(wrapped, signer);

    const subkeys = await consume(row, admin, b64(signer.publicKey));

    const independent = async (bytes: Uint8Array) =>
      crypto.subtle.importKey("raw", bytes as BufferSource, { name: "AES-GCM" }, false, [
        "encrypt",
        "decrypt",
      ]);
    // The split is at the midpoint, so each half is what an independent import
    // of those exact bytes would be.
    expect(await opens(await independent(blob.slice(0, 16)), subkeys.credentialsKey)).toBe(true);
    expect(await opens(await independent(blob.slice(16)), subkeys.transactionsKey)).toBe(true);
    expect(await opens(await independent(blob.slice(0, 16)), subkeys.transactionsKey)).toBe(false);
  });

  it("refuses a validly signed v2 grant whose blob has an odd length", async () => {
    const admin = await buildLegacyAdmin();
    const signer = generateSigKeyPair();
    const wrapped = await wrapWithoutStructureCheck(
      crypto.getRandomValues(new Uint8Array(33)),
      encoding.base64ToBytes(admin.kemPublicKeyB64),
    );
    const row = await signedV2Row(wrapped, signer);

    await expect(consume(row, admin, b64(signer.publicKey))).rejects.toThrow(
      /two equal length subkeys, got 33 bytes/,
    );
  });

  it("refuses a v2 grant whose blob was swapped after it was signed", async () => {
    const admin = await buildLegacyAdmin();
    const signer = generateSigKeyPair();
    const pub = encoding.base64ToBytes(admin.kemPublicKeyB64);
    const signedRow = await signedV2Row(
      await wrapBlob64(crypto.getRandomValues(new Uint8Array(64)), pub),
      signer,
    );
    const swapped = b64(await wrapBlob64(crypto.getRandomValues(new Uint8Array(64)), pub));

    await expect(
      consume(signedRow, admin, b64(signer.publicKey), { wrappedCiphertextB64: swapped }),
    ).rejects.toThrow(/signature invalid/);
  });

  it("carries every key generation in the grant and hands the consumer the latest of each", async () => {
    const owner = await buildV3Owner((keyring) => addDataKeyGeneration(keyring, "credentials"));
    const admin = await buildKeyringAdmin();
    const { row } = await grantV3(owner, admin);
    expect(owner.keyring.credentials).toHaveLength(2);

    // Nothing is dropped at grant time: the sealed projection holds both
    // generations of the credentials key.
    const cak = await unwrapCoAdminKey(encoding.base64ToBytes(str(row, "wrapped_cak")), admin.kemSecretKey);
    const projection = await openCoAdminKeyring(str(row, "coadmin_keyring_ciphertext"), cak, {
      ownerUserId: OWNER_USER_ID,
      grantId: str(row, "id"),
    });
    expect(projection.credentials.map((e) => e.generation)).toEqual([1, 2]);
    expect(projection.transactions.map((e) => e.generation)).toEqual([1]);

    // The consume side returns ONE key of each kind, the latest generation.
    const subkeys = await consume(row, admin, owner.sigPublicKeyB64);
    const latest = await importDataKey(latestDataKey(owner.keyring, "credentials"));
    expect(await opens(latest, subkeys.credentialsKey)).toBe(true);

    // DOCUMENTED LIMIT, pinned so lifting it is a deliberate change: data
    // written under generation 1 does not open with the single key returned
    // here. A generation aware read is a follow up and is not part of this
    // change.
    const generationOne = await importDataKey(owner.keyring.credentials[0]);
    expect(await opens(generationOne, subkeys.credentialsKey)).toBe(false);
  });
});
