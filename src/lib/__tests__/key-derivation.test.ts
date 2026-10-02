/**
 * Tests for src/lib/key-derivation.ts: which subkeys may be exported back into
 * JavaScript as raw bytes, and which may not.
 *
 * This is the property that had no test. Every derived subkey encrypts and
 * decrypts the same way whether or not it is extractable, so an over-permissive
 * import is invisible at runtime and stays that way until someone reads the
 * file. Asserting it here is what makes it hold.
 *
 * Both directions matter:
 *
 *   Non-extractable: the PQC secret wrap key, the verifier key and the keyring
 *   wrap key are used only for a local encrypt or decrypt, so their bytes have
 *   no reason to be readable.
 *
 *   Extractable, deliberately: the credentials and transactions subkeys are
 *   exported once as raw bytes for the sync handoff. Hardening those would
 *   break that path, so the test says so rather than leaving the next reader to
 *   guess whether it was an oversight.
 *
 * vitest runs with the Web Crypto API, so no mock is needed.
 */

import { describe, it, expect } from "vitest";
import {
  deriveCredentialsKey,
  deriveTransactionsKey,
  derivePqcSecretWrapKey,
  deriveVerifierKey,
  deriveKeyringWrapKey,
} from "../key-derivation";
import { encryptString, decryptString } from "../vault";

/** 16 bytes, base64. Any stable salt works: nothing here depends on its value. */
const SALT_B64 = "AAECAwQFBgcICQoLDA0ODw==";

/** An HKDF CryptoKey shaped like the MEK the vault holds after unlock. */
async function makeMek(): Promise<CryptoKey> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "HKDF" }, false, [
    "deriveBits",
  ]);
}

describe("key-derivation: keys that must never leave as raw bytes", () => {
  it("the PQC secret wrap key is non-extractable and refuses export", async () => {
    const key = await derivePqcSecretWrapKey(await makeMek(), SALT_B64);

    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });

  it("the verifier and keyring wrap keys are non-extractable", async () => {
    const mek = await makeMek();

    for (const derive of [deriveVerifierKey, deriveKeyringWrapKey]) {
      const key = await derive(mek, SALT_B64);
      expect(key.extractable).toBe(false);
    }
  });
});

describe("key-derivation: the PQC wrap key still does its job", () => {
  it("round-trips a secret through encryptString and decryptString", async () => {
    const key = await derivePqcSecretWrapKey(await makeMek(), SALT_B64);

    const ciphertext = await encryptString("pqc-secret-key-bytes", key);
    expect(await decryptString(ciphertext, key)).toBe("pqc-secret-key-bytes");
  });

  it("derives the same key twice, so already-wrapped secrets still open", async () => {
    // The import flag changed; the derived bytes did not. Wrapping with one
    // instance and opening with a second, separately derived one is the closest
    // this can get to proving a secret wrapped before the change still opens
    // after it.
    const mek = await makeMek();
    const first = await derivePqcSecretWrapKey(mek, SALT_B64);
    const second = await derivePqcSecretWrapKey(mek, SALT_B64);

    const ciphertext = await encryptString("wrapped-before-the-change", first);
    expect(await decryptString(ciphertext, second)).toBe("wrapped-before-the-change");
  });
});

describe("key-derivation: keys the sync handoff exports on purpose", () => {
  it("the credentials and transactions subkeys stay extractable", async () => {
    // Do not "harden" these. VaultContext exports both as raw bytes for a
    // single sync request (exportCredentialsKeyForSync,
    // exportTransactionsKeyForSync); a non-extractable key throws there.
    const mek = await makeMek();

    for (const derive of [deriveCredentialsKey, deriveTransactionsKey]) {
      const key = await derive(mek, SALT_B64);
      expect(key.extractable).toBe(true);

      const raw = await crypto.subtle.exportKey("raw", key);
      expect(raw.byteLength).toBe(32);
    }
  });
});
