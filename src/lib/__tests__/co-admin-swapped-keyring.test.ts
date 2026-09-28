/**
 * Envelope v3, construction (d): a sealed keyring cannot be moved between two
 * grants of the same owner (OR-T0769).
 *
 * WHY THIS FILE EXISTS. Two grants made by one owner share the owner id, so
 * the owner id bound into the seal cannot tell them apart. What keeps one
 * grant's sealed keyring out of another grant's row is the key each grant
 * mints for itself and the grant id bound into the seal. The primitives have
 * tests of their own. This file pins the same promise on the consume path,
 * which is the function the app calls after it reads a stored row.
 *
 * WHAT IS DELIBERATELY NOT MOCKED. Nothing about the cryptography. The two
 * decrypt steps of a v3 consume (unwrapCoAdminKey and openCoAdminKeyring) are
 * wrapped in spies that still call the real implementation, only so a test can
 * say which step refused.
 *
 * Run with:
 *   bunx vitest run src/lib/__tests__/co-admin-swapped-keyring.test.ts
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

import { grantCoAdminV3, loadAdminSubkeysDirect } from "../co-admin";
import type { CoAdminSupabaseLike, LoadAdminSubkeysParams } from "../co-admin";
import {
  openCoAdminKeyring,
  projectKeyringForCoAdmin,
  sealCoAdminKeyring,
  unwrapCoAdminKey,
} from "../co-admin-keyring";
import { generateVaultKeyring, withPqcSecrets, wrapKeyring } from "../keyring";
import type { VaultKeyring } from "../keyring";
import { encoding, generateMekBytes, importMekAsHkdf } from "../vault";
import { generateHybridKemKeyPair, generateSigKeyPair } from "../pqc";

const OWNER_USER_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN_USER_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_KEY_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.mocked(unwrapCoAdminKey).mockClear();
  vi.mocked(openCoAdminKeyring).mockClear();
});

// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------

type StoredGrant = Record<string, unknown>;

function b64(bytes: Uint8Array): string {
  return encoding.bytesToBase64(bytes);
}

function randomSaltB64(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}

function str(row: StoredGrant, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new Error(`stored grant has no text column ${column}`);
  return value;
}

/**
 * A Supabase stub that keeps the rows a grant writes. A read or a delete during
 * a grant is a failure: the grant flow has no business making one.
 */
function recordingSupabase(): {
  supabase: CoAdminSupabaseLike;
  inserts: { table: string; row: StoredGrant }[];
} {
  const inserts: { table: string; row: StoredGrant }[] = [];
  const supabase = {
    from(table: string) {
      return {
        select() {
          throw new Error(`unexpected select on ${table} during grant`);
        },
        insert(row: StoredGrant) {
          inserts.push({ table, row });
          return Promise.resolve({ data: [row], error: null });
        },
        delete() {
          throw new Error(`unexpected delete on ${table} during grant`);
        },
      };
    },
    rpc() {
      return Promise.resolve({ data: WORKSPACE_KEY_ID, error: null });
    },
  };
  return { supabase: supabase as unknown as CoAdminSupabaseLike, inserts };
}

// ------------------------------------------------------------------
// The owner and the recipient, both on a keyring vault
// ------------------------------------------------------------------

interface Owner {
  mek: CryptoKey;
  saltB64: string;
  keyring: VaultKeyring;
  keyringCiphertext: string;
  keyringEpoch: number;
  sigPublicKeyB64: string;
}

async function buildOwner(): Promise<Owner> {
  const saltB64 = randomSaltB64();
  const mek = await importMekAsHkdf(generateMekBytes());
  const sig = generateSigKeyPair();
  const kem = generateHybridKemKeyPair();
  const keyring = withPqcSecrets(generateVaultKeyring(), {
    kemSecretB64: b64(kem.secretKey),
    sigSecretB64: b64(sig.secretKey),
  });
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

interface Admin {
  mek: CryptoKey;
  saltB64: string;
  kemPublicKeyB64: string;
  kemSecretKey: Uint8Array;
  keyringCiphertext: string;
  keyringEpoch: number;
}

async function buildAdmin(): Promise<Admin> {
  const saltB64 = randomSaltB64();
  const mek = await importMekAsHkdf(generateMekBytes());
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
    kemSecretKey: kem.secretKey,
    keyringCiphertext,
    keyringEpoch,
  };
}

// ------------------------------------------------------------------
// A grant, produced by the real code, and a consume, the way the app runs it
// ------------------------------------------------------------------

async function grant(owner: Owner, admin: Admin): Promise<StoredGrant> {
  const { supabase, inserts } = recordingSupabase();
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
  const written = inserts.find((i) => i.table === "wrapped_data_keys");
  if (!written) throw new Error("no wrapped_data_keys row was written");
  return written.row;
}

async function consume(
  row: StoredGrant,
  admin: Admin,
  ownerSigPubB64: string,
  overrides: Record<string, unknown> = {},
) {
  const params = {
    grantId: str(row, "id"),
    ownerUserId: OWNER_USER_ID,
    wrappedCakB64: str(row, "wrapped_cak"),
    coadminKeyringCiphertextB64: str(row, "coadmin_keyring_ciphertext"),
    kemSecretWrapped: null,
    adminKeyringCiphertext: admin.keyringCiphertext,
    adminKeyringEpoch: admin.keyringEpoch,
    adminMek: admin.mek,
    adminSaltB64: admin.saltB64,
    grantSigB64: str(row, "grant_sig"),
    ownerSigPubB64,
    granteeUserId: ADMIN_USER_ID,
    ownerWorkspaceKeyId: WORKSPACE_KEY_ID,
    ...overrides,
  } as unknown as LoadAdminSubkeysParams;
  return loadAdminSubkeysDirect(params);
}

/** The per grant key, opened the way the recipient opens it. */
async function cakOf(row: StoredGrant, admin: Admin): Promise<Uint8Array> {
  return unwrapCoAdminKey(encoding.base64ToBytes(str(row, "wrapped_cak")), admin.kemSecretKey);
}

// ==================================================================
// A sealed keyring cannot be moved between two grants of one owner
// ==================================================================

describe("a sealed keyring cannot be moved between two grants of the same owner", () => {
  let owner: Owner;
  let admin: Admin;
  let first: StoredGrant;
  let second: StoredGrant;

  beforeAll(async () => {
    owner = await buildOwner();
    admin = await buildAdmin();
    // One owner, one recipient, two grants. What differs between the two rows
    // is only what each grant mints for itself.
    first = await grant(owner, admin);
    second = await grant(owner, admin);
  }, 60_000);

  it("control: the two grants are different, and each opens with its own sealed keyring", async () => {
    expect(str(first, "id")).not.toBe(str(second, "id"));
    expect(str(first, "coadmin_keyring_ciphertext")).not.toBe(
      str(second, "coadmin_keyring_ciphertext"),
    );

    await expect(consume(first, admin, owner.sigPublicKeyB64)).resolves.toBeTruthy();
    await expect(consume(second, admin, owner.sigPublicKeyB64)).resolves.toBeTruthy();
    // Without this, every refusal below could also come from a spy that
    // observes nothing.
    expect(unwrapCoAdminKey).toHaveBeenCalledTimes(2);
    expect(openCoAdminKeyring).toHaveBeenCalledTimes(2);
  });

  it("the two grants hold different keys, which is why one grant's keyring does not open in the other", async () => {
    const firstKey = await cakOf(first, admin);
    const secondKey = await cakOf(second, admin);
    expect(b64(firstKey)).not.toBe(b64(secondKey));
  });

  it("refuses the other grant's sealed keyring in place of its own, in both directions", async () => {
    await expect(
      consume(first, admin, owner.sigPublicKeyB64, {
        coadminKeyringCiphertextB64: str(second, "coadmin_keyring_ciphertext"),
      }),
    ).rejects.toBeTruthy();
    await expect(
      consume(second, admin, owner.sigPublicKeyB64, {
        coadminKeyringCiphertextB64: str(first, "coadmin_keyring_ciphertext"),
      }),
    ).rejects.toBeTruthy();

    // The sealed keyring is outside the signed set on purpose: the signature
    // covers the wrapped key, and without that key the sealed keyring is
    // inert. So the signature check passes here and the refusal comes from the
    // seal itself. Each attempt reached the open step, and that step threw.
    expect(unwrapCoAdminKey).toHaveBeenCalledTimes(2);
    expect(openCoAdminKeyring).toHaveBeenCalledTimes(2);
  });

  it("refuses a keyring sealed under the very same key but bound to another grant's id", async () => {
    // Everything is held equal except the grant id inside the seal: same
    // owner, same key, same contents. A refusal below can only come from the
    // grant id, and the control in the same test shows the fixture itself opens.
    const cak = await cakOf(first, admin);
    const projection = projectKeyringForCoAdmin(owner.keyring);
    const boundToItsOwnGrant = await sealCoAdminKeyring(projection, cak, {
      ownerUserId: OWNER_USER_ID,
      grantId: str(first, "id"),
    });
    const boundToTheOtherGrant = await sealCoAdminKeyring(projection, cak, {
      ownerUserId: OWNER_USER_ID,
      grantId: str(second, "id"),
    });

    await expect(
      consume(first, admin, owner.sigPublicKeyB64, {
        coadminKeyringCiphertextB64: boundToItsOwnGrant,
      }),
    ).resolves.toBeTruthy();
    await expect(
      consume(first, admin, owner.sigPublicKeyB64, {
        coadminKeyringCiphertextB64: boundToTheOtherGrant,
      }),
    ).rejects.toBeTruthy();
  });
});
