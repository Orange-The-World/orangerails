/**
 * Keyring-aware recovery tests , envelope v3, slice B1.
 *
 * Run with:
 *   bunx vitest run src/lib/__tests__/keyring-recovery.test.ts
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { recoverKeyringVault } from "../keyring-recovery";
import {
  dataKeyFor,
  generateVaultKeyring,
  unwrapKeyring,
  withPqcSecrets,
  wrapKeyring,
  type KeyringBinding,
} from "../keyring";
import {
  createVaultVerifier,
  decryptString,
  deriveRecoveryKek,
  encryptString,
  generateMekBytes,
  generateRecoveryCode,
  generateVaultSalt,
  importMekAsHkdf,
  unwrapMekBytes,
  verifyVaultPassword,
  wrapMekBytes,
} from "../vault";
import { deriveVerifierKey } from "../key-derivation";

const USER = "11111111-2222-3333-4444-555555555555";
const EPOCH = 4;
const BINDING = { userId: USER, keyringEpoch: EPOCH } satisfies KeyringBinding;

async function newPasswordKek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** A stored v3 vault: old MEK, recovery envelope, verifier and a sealed keyring. */
async function storedVault() {
  const saltB64 = generateVaultSalt();
  const oldMekRaw = generateMekBytes();
  const oldMek = await importMekAsHkdf(oldMekRaw);
  const recoveryCode = generateRecoveryCode();
  const recoveryCiphertext = await wrapMekBytes(oldMekRaw, await deriveRecoveryKek(recoveryCode));
  const verifierCiphertext = await createVaultVerifier(await deriveVerifierKey(oldMek, saltB64));
  const keyring = withPqcSecrets(generateVaultKeyring(), {
    kemSecretB64: "kem-secret-placeholder",
    sigSecretB64: "sig-secret-placeholder",
  });
  const keyringCiphertext = await wrapKeyring(keyring, oldMek, saltB64, BINDING);
  return { saltB64, oldMek, recoveryCode, recoveryCiphertext, verifierCiphertext, keyring, keyringCiphertext };
}

type Stored = Awaited<ReturnType<typeof storedVault>>;

function paramsFor(v: Stored, kek: CryptoKey, overrides: Record<string, unknown> = {}) {
  return {
    recoveryCode: v.recoveryCode,
    recoveryCiphertext: v.recoveryCiphertext,
    saltB64: v.saltB64,
    verifierCiphertext: v.verifierCiphertext,
    keyringCiphertext: v.keyringCiphertext,
    binding: BINDING,
    newPasswordKek: kek,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recoverKeyringVault , result", () => {
  test("every new artifact opens under the new MEK and the epoch is raised by one", async () => {
    const v = await storedVault();
    const kek = await newPasswordKek();
    const r = await recoverKeyringVault(paramsFor(v, kek));

    expect(r.newKeyringEpoch).toBe(EPOCH + 1);

    // Password envelope and new recovery envelope both open to the same MEK.
    const viaPassword = await unwrapMekBytes(r.newEncMekCiphertext, kek);
    const viaRecovery = await unwrapMekBytes(
      r.newRecoveryCiphertext,
      await deriveRecoveryKek(r.newRecoveryCode),
    );
    expect(Array.from(viaPassword)).toEqual(Array.from(viaRecovery));

    // New verifier opens under the new MEK, the old verifier does not.
    const newVerifierKey = await deriveVerifierKey(r.newMek, v.saltB64);
    expect(await verifyVaultPassword(newVerifierKey, r.newVerifierCiphertext)).toBe(true);
    expect(await verifyVaultPassword(newVerifierKey, v.verifierCiphertext)).toBe(false);

    // New keyring opens under the new MEK at the NEW epoch only.
    const reopened = await unwrapKeyring(r.newKeyringCiphertext, r.newMek, v.saltB64, {
      userId: USER,
      keyringEpoch: EPOCH + 1,
    });
    expect(reopened).toEqual(v.keyring);
    await expect(
      unwrapKeyring(r.newKeyringCiphertext, r.newMek, v.saltB64, BINDING),
    ).rejects.toThrow();
    await expect(
      unwrapKeyring(r.newKeyringCiphertext, v.oldMek, v.saltB64, {
        userId: USER,
        keyringEpoch: EPOCH + 1,
      }),
    ).rejects.toThrow();
  });

  test("data keys do not move: a row sealed before recovery opens after it, with no row touched", async () => {
    const v = await storedVault();
    const rowKeyBefore = await dataKeyFor(v.keyring, "credentials");
    const row = await encryptString("a stored credential row", rowKeyBefore);

    const r = await recoverKeyringVault(paramsFor(v, await newPasswordKek()));

    const rowKeyAfter = await dataKeyFor(r.keyring, "credentials");
    expect(await decryptString(row, rowKeyAfter)).toBe("a stored credential row");
    // PQC secrets ride inside the keyring, so there is nothing separate to carry.
    expect(r.keyring.kemSecretB64).toBe("kem-secret-placeholder");
    expect(r.keyring.sigSecretB64).toBe("sig-secret-placeholder");
  });

  test("the new recovery code is fresh and the old code opens nothing new", async () => {
    const v = await storedVault();
    const r = await recoverKeyringVault(paramsFor(v, await newPasswordKek()));
    expect(r.newRecoveryCode).not.toBe(v.recoveryCode);
    await expect(
      unwrapMekBytes(r.newRecoveryCiphertext, await deriveRecoveryKek(v.recoveryCode)),
    ).rejects.toThrow();
  });
});

describe("recoverKeyringVault , refusals", () => {
  test("a wrong recovery code is refused", async () => {
    const v = await storedVault();
    await expect(
      recoverKeyringVault(
        paramsFor(v, await newPasswordKek(), { recoveryCode: generateRecoveryCode() }),
      ),
    ).rejects.toThrow();
  });

  test("a recovery code that belongs to a different vault is refused by the verifier", async () => {
    const v = await storedVault();
    const other = await storedVault();
    await expect(
      recoverKeyringVault(
        paramsFor(v, await newPasswordKek(), { verifierCiphertext: other.verifierCiphertext }),
      ),
    ).rejects.toThrow("Recovery code does not match this vault.");
  });

  test("a keyring bound to another user or another epoch is refused", async () => {
    const v = await storedVault();
    const kek = await newPasswordKek();
    await expect(
      recoverKeyringVault(
        paramsFor(v, kek, { binding: { userId: "99999999-2222-3333-4444-555555555555", keyringEpoch: EPOCH } }),
      ),
    ).rejects.toThrow();
    await expect(
      recoverKeyringVault(paramsFor(v, kek, { binding: { userId: USER, keyringEpoch: EPOCH + 1 } })),
    ).rejects.toThrow();
  });

  test("an empty keyring ciphertext is refused as not applicable", async () => {
    const v = await storedVault();
    await expect(
      recoverKeyringVault(paramsFor(v, await newPasswordKek(), { keyringCiphertext: "" })),
    ).rejects.toThrow("no keyring");
  });
});

describe("recoverKeyringVault , kill at every await", () => {
  const SUBTLE_CALLS = [
    "encrypt",
    "decrypt",
    "importKey",
    "deriveKey",
    "deriveBits",
    "exportKey",
    "digest",
    "sign",
    "verify",
    "generateKey",
  ] as const;

  /** Fail the failAt-th WebCrypto call (1-based). failAt 0 only counts. */
  function installKiller(failAt: number) {
    let calls = 0;
    const subtle = crypto.subtle as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    for (const name of SUBTLE_CALLS) {
      const original = subtle[name].bind(crypto.subtle);
      vi.spyOn(subtle, name).mockImplementation((...args: unknown[]) => {
        calls += 1;
        if (calls === failAt) return Promise.reject(new Error("injected kill"));
        return original(...args);
      });
    }
    return { count: () => calls };
  }

  test("a failure at any single WebCrypto call rejects, and the stored vault still opens", async () => {
    const v = await storedVault();
    const kek = await newPasswordKek();

    const counter = installKiller(0);
    await recoverKeyringVault(paramsFor(v, kek));
    const total = counter.count();
    vi.restoreAllMocks();
    // A run this short would mean the harness is counting nothing.
    expect(total).toBeGreaterThan(15);

    for (let k = 1; k <= total; k++) {
      installKiller(k);
      let outcome: "resolved" | "rejected" = "resolved";
      try {
        await recoverKeyringVault(paramsFor(v, kek));
      } catch {
        outcome = "rejected";
      }
      vi.restoreAllMocks();
      expect({ killedCall: k, outcome }).toEqual({ killedCall: k, outcome: "rejected" });

      // Nothing was persisted, so the old recovery code and the old keyring
      // still open exactly as before.
      const reopenedMek = await unwrapMekBytes(v.recoveryCiphertext, await deriveRecoveryKek(v.recoveryCode));
      expect(reopenedMek.length).toBe(32);
      expect(await unwrapKeyring(v.keyringCiphertext, v.oldMek, v.saltB64, BINDING)).toEqual(v.keyring);
    }
  });
});
