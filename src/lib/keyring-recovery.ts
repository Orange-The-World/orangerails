/**
 * Keyring-aware vault recovery , envelope v3, slice B1 (pure library).
 *
 * WHAT THIS IS. The recovery path for a vault that holds a keyring. The v2
 * recovery (VaultContext recoverWithCode) makes a new MEK and then every data
 * row has to be re-encrypted, because the data keys were derived from the old
 * MEK. In v3 the data keys live in the keyring and the MEK only wraps it, so a
 * recovery re-seals one blob and touches no data row at all.
 *
 * WHAT THIS DOES.
 *   1. Opens the old MEK with the recovery code and checks it against the
 *      stored verifier.
 *   2. Generates a fresh random MEK.
 *   3. Opens the keyring with the old MEK and re-seals it under the new MEK at
 *      epoch + 1 (rewrapKeyringUnderNewMek). The keyring contents, including
 *      the PQC secrets, are carried unchanged.
 *   4. Builds the new password envelope, the new recovery code and envelope,
 *      and the new verifier.
 *   5. Proves every new artifact re-opens to what it should BEFORE returning.
 *
 * WHAT THIS DOES NOT DO.
 *   - It never talks to the database and never mutates any state or ref. A
 *     failure at any await leaves the caller holding exactly what it passed
 *     in, and every stored wrapper still valid. Nothing is half done because
 *     nothing is done until the caller persists the result.
 *   - Nothing calls it yet. It is not wired into recovery.
 *   - It does not derive the password KEK. The caller derives it with
 *     deriveKek(newPassword, saltB64) first and passes the key in, so the slow
 *     password stretch stays out of this function.
 *
 * WHAT THE CALLER OWES once it has the result. ONE database statement that
 * writes the new password envelope, the new recovery envelope, the new
 * verifier, the new keyring ciphertext and the new keyring epoch together,
 * and that matches the exact prior keyring ciphertext and epoch. A write that
 * replaces the verifier without re-sealing the keyring at a higher epoch is
 * refused by the database, and that is intended. Zero rows matched means a
 * lost race and is retryable; a guard rejection is not a race. The caller
 * must not load the new MEK into session state before that statement has
 * succeeded.
 */

import {
  assertMekEnvelopeReopens,
  createVaultVerifier,
  deriveRecoveryKek,
  generateMekBytes,
  generateRecoveryCode,
  importMekAsHkdf,
  unwrapMekBytes,
  verifyVaultPassword,
  wrapMekBytes,
} from "./vault";
import { deriveVerifierKey } from "./key-derivation";
import {
  encodeKeyring,
  rewrapKeyringUnderNewMek,
  unwrapKeyring,
  type KeyringBinding,
  type VaultKeyring,
} from "./keyring";

export interface RecoverKeyringVaultParams {
  /** The 12-word recovery code the user typed. */
  recoveryCode: string;
  /** user_vault_meta.recovery_ciphertext as stored. */
  recoveryCiphertext: string;
  /** user_vault_meta.vault_salt. Preserved: recovery does not change it. */
  saltB64: string;
  /** user_vault_meta.vault_verifier_ciphertext as stored. */
  verifierCiphertext: string;
  /** user_vault_meta.keyring_ciphertext as stored. Must be non-empty. */
  keyringCiphertext: string;
  /** The CURRENT binding: the user id and the stored keyring_epoch. */
  binding: KeyringBinding;
  /** deriveKek(newPassword, saltB64), derived by the caller. */
  newPasswordKek: CryptoKey;
}

export interface RecoverKeyringVaultResult {
  /** The new MEK. Load it into session state only AFTER the write succeeds. */
  newMek: CryptoKey;
  /** New user_vault_meta.enc_mek_ciphertext. */
  newEncMekCiphertext: string;
  /** Show once, never persist. The old code opens nothing after the write. */
  newRecoveryCode: string;
  /** New user_vault_meta.recovery_ciphertext. */
  newRecoveryCiphertext: string;
  /** New user_vault_meta.vault_verifier_ciphertext. */
  newVerifierCiphertext: string;
  /** New user_vault_meta.keyring_ciphertext. */
  newKeyringCiphertext: string;
  /** New user_vault_meta.keyring_epoch: the old epoch plus one. */
  newKeyringEpoch: number;
  /** The keyring contents, identical to what the old blob held. */
  keyring: VaultKeyring;
}

export async function recoverKeyringVault(
  params: RecoverKeyringVaultParams,
): Promise<RecoverKeyringVaultResult> {
  if (!params.keyringCiphertext) {
    throw new Error("This vault has no keyring, so keyring recovery does not apply.");
  }

  // 1. Open the OLD MEK with the recovery code and prove it matches the vault.
  const recoveryKek = await deriveRecoveryKek(params.recoveryCode);
  const oldMekRaw = await unwrapMekBytes(params.recoveryCiphertext, recoveryKek);
  const oldMek = await importMekAsHkdf(oldMekRaw);
  const oldVerifierKey = await deriveVerifierKey(oldMek, params.saltB64);
  if (!(await verifyVaultPassword(oldVerifierKey, params.verifierCiphertext))) {
    throw new Error("Recovery code does not match this vault.");
  }

  // 2. Fresh random MEK. The old one is discarded when this function returns.
  const newMekRaw = generateMekBytes();
  const newMek = await importMekAsHkdf(newMekRaw);

  // 3. Open the keyring with the old MEK, re-seal it under the new MEK at
  //    epoch + 1. Done before any envelope is built, so a keyring that will
  //    not open stops the recovery with nothing else computed.
  const rewrapped = await rewrapKeyringUnderNewMek({
    ciphertextB64: params.keyringCiphertext,
    oldMek,
    newMek,
    saltB64: params.saltB64,
    binding: params.binding,
  });

  // 4. New verifier, password envelope, recovery code and recovery envelope.
  const newVerifierKey = await deriveVerifierKey(newMek, params.saltB64);
  const newVerifierCiphertext = await createVaultVerifier(newVerifierKey);
  const newEncMekCiphertext = await wrapMekBytes(newMekRaw, params.newPasswordKek);
  const newRecoveryCode = generateRecoveryCode();
  const newRecoveryKek = await deriveRecoveryKek(newRecoveryCode);
  const newRecoveryCiphertext = await wrapMekBytes(newMekRaw, newRecoveryKek);

  // 5. Prove every new artifact re-opens to what it should. Wrapping is
  //    write-only, and a user who holds a code or password that opens nothing
  //    has no server-side copy to fall back on.
  await assertMekEnvelopeReopens(
    "New password envelope",
    newEncMekCiphertext,
    params.newPasswordKek,
    newMekRaw,
  );
  await assertMekEnvelopeReopens(
    "New recovery envelope",
    newRecoveryCiphertext,
    newRecoveryKek,
    newMekRaw,
  );
  if (!(await verifyVaultPassword(newVerifierKey, newVerifierCiphertext))) {
    throw new Error("New verifier does not open under the new MEK.");
  }
  const reopened = await unwrapKeyring(
    rewrapped.ciphertextB64,
    newMek,
    params.saltB64,
    { userId: params.binding.userId, keyringEpoch: rewrapped.keyringEpoch },
  );
  if (encodeKeyring(reopened) !== encodeKeyring(rewrapped.keyring)) {
    throw new Error("New keyring re-opened to different contents than it was given.");
  }

  return {
    newMek,
    newEncMekCiphertext,
    newRecoveryCode,
    newRecoveryCiphertext,
    newVerifierCiphertext,
    newKeyringCiphertext: rewrapped.ciphertextB64,
    newKeyringEpoch: rewrapped.keyringEpoch,
    keyring: rewrapped.keyring,
  };
}
