/**
 * Confirm that whoever is at the keyboard knows the vault password.
 *
 * WHAT THIS IS FOR. Some actions ask the owner to re-type their vault password
 * even though the vault is already unlocked, because the action gives someone
 * else access and the person doing it must be the owner rather than whoever
 * walked up to an open tab. That is a presence check, not a key derivation,
 * and the two must not be confused: an action that needs key material should
 * take the unlocked MEK, and an action that needs proof of presence should
 * come here.
 *
 * WHY IT IS NOT ONE LINE. The check differs by vault key version, and getting
 * that wrong fails in the direction that always passes.
 *
 *   v1 (legacy): the Argon2id output IS the MEK. Derive the verifier subkey
 *     from it and open the stored verifier ciphertext.
 *
 *   v2 (current): the MEK is 32 random bytes and the Argon2id output is only
 *     the KEK that wraps it. So the candidate MEK has to be unwrapped first,
 *     and only then does the verifier mean anything.
 *
 * THE TRAP. Deriving the verifier subkey from the MEK the caller already holds
 * and opening the verifier with it succeeds for ANY password, including a
 * wrong one, because the password was never involved. A confirmation written
 * that way is indistinguishable from no confirmation at all.
 *
 * This is the same sequence unlock performs. Unlock keeps its own copy for now
 * rather than being rewired here.
 */

import {
  deriveKek,
  deriveMEK,
  importMekAsHkdf,
  unwrapMekBytes,
  verifyVaultPassword,
} from "./vault";
import { deriveVerifierKey } from "./key-derivation";

export interface ConfirmVaultPasswordParams {
  /** The password as typed. Never persisted, never logged, never sent anywhere. */
  password: string;
  /** The owner's vault salt, from user_vault_meta.vault_salt. */
  saltB64: string;
  /** The stored verifier, from user_vault_meta.vault_verifier_ciphertext. */
  verifierCiphertext: string;
  /** user_vault_meta.vault_key_version. Anything below 2 is treated as legacy. */
  keyVersion: number;
  /** user_vault_meta.enc_mek_ciphertext. Required for version 2, null on legacy. */
  encMekCiphertext: string | null;
}

/**
 * True only if the password reproduces the vault's own master key.
 *
 * Every failure returns false rather than throwing, including a wrong password
 * (which surfaces as an AES-GCM authentication error) and a malformed stored
 * value. A caller must be able to treat this as one question with one answer.
 *
 * A version-2 vault with no wrapped MEK stored cannot be confirmed at all: it
 * would fall through to the legacy branch, where the Argon2id output is
 * treated as the MEK, and that comparison is meaningless on this vault. That
 * combination is a broken row rather than a wrong password, so it returns
 * false instead of guessing.
 */
export async function confirmVaultPassword(
  params: ConfirmVaultPasswordParams,
): Promise<boolean> {
  const { password, saltB64, verifierCiphertext, keyVersion, encMekCiphertext } = params;

  if (!password || !verifierCiphertext) return false;
  if (keyVersion >= 2 && !encMekCiphertext) return false;

  try {
    let candidateMek: CryptoKey;

    if (keyVersion >= 2 && encMekCiphertext) {
      const kek = await deriveKek(password, saltB64);
      const mekRaw = await unwrapMekBytes(encMekCiphertext, kek);
      candidateMek = await importMekAsHkdf(mekRaw);
    } else {
      candidateMek = await deriveMEK(password, saltB64);
    }

    const verifierKey = await deriveVerifierKey(candidateMek, saltB64);
    return await verifyVaultPassword(verifierKey, verifierCiphertext);
  } catch {
    // A wrong password reaches here as a decryption failure on the wrapped
    // MEK. Returning false is the whole answer; there is nothing a caller
    // could usefully do with the exception.
    return false;
  }
}
