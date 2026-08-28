/**
 * Co-admin keyring tests, envelope v3.
 *
 * The property under test, and the reason this module exists: an admin gets
 * the owner's DATA keys and never the owner's secret keys. If the ML-DSA
 * signing secret ever reached an admin, that admin could mint grants in the
 * owner's name, so "may read my data" would silently become "is me".
 *
 * The leak assertions are made against the SEALED BYTES, not against the
 * returned object. An object level assertion would still pass if the encoder
 * put a secret on the wire, and the wire is what an admin receives.
 *
 * Run with:
 *   bunx vitest run src/lib/__tests__/co-admin-keyring.test.ts
 */

import { describe, expect, test } from "vitest";
import {
  COADMIN_CAK_VERSION,
  COADMIN_KEYRING_VERSION,
  coAdminDataKeyAt,
  coAdminDataKeyFor,
  decodeCoAdminKeyring,
  encodeCoAdminKeyring,
  generateCoAdminKey,
  latestCoAdminDataKey,
  openCoAdminKeyring,
  projectKeyringForCoAdmin,
  sealCoAdminKeyring,
  unwrapCoAdminKey,
  wrapCoAdminKey,
  type CoAdminBinding,
} from "../co-admin-keyring";
import {
  addDataKeyGeneration,
  dataKeyFor,
  generateVaultKeyring,
  withPqcSecrets,
  type VaultKeyring,
} from "../keyring";
import { decryptString, encoding, encryptString } from "../vault";
import { generateHybridKemKeyPair, hybridEncapsulate, HYBRID_KEM_CIPHERTEXT_BYTES } from "../pqc";

const OWNER_ID = "11111111-2222-3333-4444-555555555555";
const GRANT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER_GRANT_ID = "99999999-8888-7777-6666-555555555555";

const BINDING: CoAdminBinding = { ownerUserId: OWNER_ID, grantId: GRANT_ID };

/** Two obvious, findable secrets so a leak shows up as a substring match. */
const KEM_SECRET_B64 = encoding.bytesToBase64(new TextEncoder().encode("OWNER-KEM-SECRET-000"));
const SIG_SECRET_B64 = encoding.bytesToBase64(new TextEncoder().encode("OWNER-SIG-SECRET-000"));

/** An owner keyring carrying both PQC secrets, which is the v3 steady state. */
function ownerKeyringWithSecrets(): VaultKeyring {
  return withPqcSecrets(generateVaultKeyring(), {
    kemSecretB64: KEM_SECRET_B64,
    sigSecretB64: SIG_SECRET_B64,
  });
}

/**
 * Decrypt a sealed co-admin blob back to its raw plaintext string, so a test
 * can look at what actually went on the wire rather than at what the parser
 * chose to hand back.
 */
async function sealedPlaintext(
  ciphertextB64: string,
  cak: Uint8Array,
  binding: CoAdminBinding,
): Promise<string> {
  const combined = encoding.base64ToBytes(ciphertextB64);
  const iv = combined.slice(0, 12);
  const body = combined.slice(12);
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(cak) as BufferSource,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const aad = new TextEncoder().encode(
    JSON.stringify(["orangerails-coadmin-keyring-v1", binding.ownerUserId, binding.grantId]),
  );
  const opened = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: aad as BufferSource },
    key,
    body as BufferSource,
  );
  return new TextDecoder().decode(new Uint8Array(opened));
}

// ------------------------------------------------------------------
// The projection: an allowlist of exactly two fields
// ------------------------------------------------------------------

describe("co-admin keyring, projection", () => {
  test("carries every generation of both data keys, byte for byte", () => {
    let owner = ownerKeyringWithSecrets();
    owner = addDataKeyGeneration(owner, "credentials");

    const projection = projectKeyringForCoAdmin(owner);

    expect(projection.version).toBe(COADMIN_KEYRING_VERSION);
    expect(projection.credentials.map((e) => e.generation)).toEqual([1, 2]);
    expect(projection.transactions.map((e) => e.generation)).toEqual([1]);
    expect(projection.credentials[0].keyB64).toBe(owner.credentials[0].keyB64);
    expect(projection.credentials[1].keyB64).toBe(owner.credentials[1].keyB64);
    expect(projection.transactions[0].keyB64).toBe(owner.transactions[0].keyB64);
  });

  test("an owner keyring holding a KEM secret and a signing secret yields a blob with neither", async () => {
    const owner = ownerKeyringWithSecrets();
    const cak = generateCoAdminKey();

    const sealed = await sealCoAdminKeyring(projectKeyringForCoAdmin(owner), cak, BINDING);
    const wire = await sealedPlaintext(sealed, cak, BINDING);

    expect(wire).not.toContain(KEM_SECRET_B64);
    expect(wire).not.toContain(SIG_SECRET_B64);
    expect(Object.keys(JSON.parse(wire)).sort()).toEqual(["creds", "txns", "v"]);
  });

  test("a field added to the keyring later does not reach the wire by default", async () => {
    const owner = ownerKeyringWithSecrets() as VaultKeyring & Record<string, unknown>;
    owner.recoveryEscrowSecretB64 = "FUTURE-SECRET-NOBODY-UPDATED-A-DENYLIST-FOR";

    const cak = generateCoAdminKey();
    const sealed = await sealCoAdminKeyring(projectKeyringForCoAdmin(owner), cak, BINDING);
    const wire = await sealedPlaintext(sealed, cak, BINDING);

    expect(wire).not.toContain("FUTURE-SECRET-NOBODY-UPDATED-A-DENYLIST-FOR");
    expect(wire).not.toContain("recoveryEscrowSecretB64");
  });

  test("the encoding is canonical: the same projection always produces the same bytes", () => {
    const owner = addDataKeyGeneration(ownerKeyringWithSecrets(), "transactions");
    const forward = projectKeyringForCoAdmin(owner);
    const reversed = {
      ...forward,
      transactions: [...forward.transactions].reverse(),
    };

    expect(encodeCoAdminKeyring(reversed)).toBe(encodeCoAdminKeyring(forward));
  });
});

// ------------------------------------------------------------------
// Seal and open
// ------------------------------------------------------------------

describe("co-admin keyring, seal and open", () => {
  test("round trips to the same data keys", async () => {
    const owner = addDataKeyGeneration(ownerKeyringWithSecrets(), "credentials");
    const cak = generateCoAdminKey();

    const sealed = await sealCoAdminKeyring(projectKeyringForCoAdmin(owner), cak, BINDING);
    const opened = await openCoAdminKeyring(sealed, cak, BINDING);

    expect(opened.credentials.map((e) => e.keyB64)).toEqual(
      owner.credentials.map((e) => e.keyB64),
    );
    expect(opened.transactions.map((e) => e.keyB64)).toEqual(
      owner.transactions.map((e) => e.keyB64),
    );
  });

  test("the admin's key decrypts what the owner's key encrypted", async () => {
    const owner = ownerKeyringWithSecrets();
    const cak = generateCoAdminKey();

    const ciphertext = await encryptString(
      "account balance the owner encrypted",
      await dataKeyFor(owner, "transactions"),
    );

    const sealed = await sealCoAdminKeyring(projectKeyringForCoAdmin(owner), cak, BINDING);
    const opened = await openCoAdminKeyring(sealed, cak, BINDING);

    await expect(
      decryptString(ciphertext, await coAdminDataKeyFor(opened, "transactions")),
    ).resolves.toBe("account balance the owner encrypted");
  });

  test("another grant's blob does not open in this grant's binding", async () => {
    const owner = ownerKeyringWithSecrets();
    const cak = generateCoAdminKey();

    const sealedForOtherGrant = await sealCoAdminKeyring(
      projectKeyringForCoAdmin(owner),
      cak,
      { ownerUserId: OWNER_ID, grantId: OTHER_GRANT_ID },
    );

    await expect(openCoAdminKeyring(sealedForOtherGrant, cak, BINDING)).rejects.toThrow();
  });

  test("a blob sealed for another owner does not open", async () => {
    const owner = ownerKeyringWithSecrets();
    const cak = generateCoAdminKey();

    const sealed = await sealCoAdminKeyring(projectKeyringForCoAdmin(owner), cak, {
      ownerUserId: "00000000-0000-0000-0000-000000000000",
      grantId: GRANT_ID,
    });

    await expect(openCoAdminKeyring(sealed, cak, BINDING)).rejects.toThrow();
  });

  test("the wrong CAK does not open the blob", async () => {
    const owner = ownerKeyringWithSecrets();
    const sealed = await sealCoAdminKeyring(
      projectKeyringForCoAdmin(owner),
      generateCoAdminKey(),
      BINDING,
    );

    await expect(
      openCoAdminKeyring(sealed, generateCoAdminKey(), BINDING),
    ).rejects.toThrow();
  });

  test("an empty grant id is refused rather than silently binding to nothing", async () => {
    const owner = ownerKeyringWithSecrets();
    await expect(
      sealCoAdminKeyring(projectKeyringForCoAdmin(owner), generateCoAdminKey(), {
        ownerUserId: OWNER_ID,
        grantId: "",
      }),
    ).rejects.toThrow(/grant id/i);
  });
});

// ------------------------------------------------------------------
// Version handling
// ------------------------------------------------------------------

describe("co-admin keyring, version", () => {
  test("a version mismatch is rejected before any other field is read", () => {
    const hostile = JSON.stringify({ v: 99, creds: "not an array", txns: null });

    expect(() => decodeCoAdminKeyring(hostile)).toThrow(/version/i);
    expect(() => decodeCoAdminKeyring(hostile)).not.toThrow(/credentials/i);
  });

  test("a missing version is a version mismatch, not a default", () => {
    expect(() => decodeCoAdminKeyring(JSON.stringify({ creds: [], txns: [] }))).toThrow(
      /version/i,
    );
  });
});

// ------------------------------------------------------------------
// Wrapping the CAK to the admin
// ------------------------------------------------------------------

describe("co-admin key wrap", () => {
  test("round trips through the admin's hybrid KEM keypair", async () => {
    const admin = generateHybridKemKeyPair();
    const cak = generateCoAdminKey();

    const wrapped = await wrapCoAdminKey(cak, admin.publicKey);
    const unwrapped = await unwrapCoAdminKey(wrapped, admin.secretKey);

    expect(Array.from(unwrapped)).toEqual(Array.from(cak));
  });

  test("a different admin cannot unwrap it", async () => {
    const admin = generateHybridKemKeyPair();
    const stranger = generateHybridKemKeyPair();

    const wrapped = await wrapCoAdminKey(generateCoAdminKey(), admin.publicKey);

    await expect(unwrapCoAdminKey(wrapped, stranger.secretKey)).rejects.toThrow();
  });

  test("a payload carrying an unknown future field still unwraps", async () => {
    // This is the property a hardcoded length check destroys. The payload is
    // longer than one this build would write, and the CAK still comes out.
    const admin = generateHybridKemKeyPair();
    const cak = generateCoAdminKey();

    const payload = JSON.stringify({
      v: COADMIN_CAK_VERSION,
      cak: encoding.bytesToBase64(cak),
      issuedAt: "2026-08-28T00:00:00.000Z",
      note: "a field a later build added",
    });

    const { ciphertext: kemCt, sharedSecret } = hybridEncapsulate(admin.publicKey);
    const aesKey = await crypto.subtle.importKey(
      "raw",
      sharedSecret as BufferSource,
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      aesKey,
      new TextEncoder().encode(payload) as BufferSource,
    );

    const wrapped = new Uint8Array(kemCt.length + 12 + sealed.byteLength);
    wrapped.set(kemCt, 0);
    wrapped.set(iv, kemCt.length);
    wrapped.set(new Uint8Array(sealed), kemCt.length + 12);

    const unwrapped = await unwrapCoAdminKey(wrapped, admin.secretKey);
    expect(Array.from(unwrapped)).toEqual(Array.from(cak));
  });

  test("a truncated wrap is refused by the structural minimum", async () => {
    const admin = generateHybridKemKeyPair();
    const wrapped = await wrapCoAdminKey(generateCoAdminKey(), admin.publicKey);

    await expect(
      unwrapCoAdminKey(wrapped.subarray(0, HYBRID_KEM_CIPHERTEXT_BYTES), admin.secretKey),
    ).rejects.toThrow(/shorter than/i);
  });

  test("a CAK that is not 32 bytes is refused at wrap time", async () => {
    const admin = generateHybridKemKeyPair();
    await expect(wrapCoAdminKey(new Uint8Array(16), admin.publicKey)).rejects.toThrow(
      /32 bytes/,
    );
  });
});

// ------------------------------------------------------------------
// Generation lookup, same rules as the owner path
// ------------------------------------------------------------------

describe("co-admin keyring, generation lookup", () => {
  test("names the newest generation when none is asked for", () => {
    const owner = addDataKeyGeneration(ownerKeyringWithSecrets(), "credentials");
    const projection = projectKeyringForCoAdmin(owner);

    expect(latestCoAdminDataKey(projection, "credentials").generation).toBe(2);
  });

  test("a generation the keyring does not hold throws by number, with no fallback", () => {
    const projection = projectKeyringForCoAdmin(ownerKeyringWithSecrets());

    expect(() => coAdminDataKeyAt(projection, "credentials", 7)).toThrow(
      /generation 7.*Present: 1/s,
    );
  });

  test("an older generation still decrypts an older row", async () => {
    const before = ownerKeyringWithSecrets();
    const oldCiphertext = await encryptString(
      "written under generation 1",
      await dataKeyFor(before, "credentials"),
    );

    const after = addDataKeyGeneration(before, "credentials");
    const cak = generateCoAdminKey();
    const sealed = await sealCoAdminKeyring(projectKeyringForCoAdmin(after), cak, BINDING);
    const opened = await openCoAdminKeyring(sealed, cak, BINDING);

    await expect(
      decryptString(oldCiphertext, await coAdminDataKeyFor(opened, "credentials", 1)),
    ).resolves.toBe("written under generation 1");
  });
});
