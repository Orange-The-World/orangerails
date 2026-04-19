/**
 * VaultContext — React state for the OrangeRails session-based vault.
 *
 * Holds the user's Master Encryption Key (MEK) in React state (which means,
 * in browser memory only, for the duration of this tab). When the vault is
 * "locked," the MEK is null and no encryption operations are possible.
 *
 * What this component does NOT do:
 *   - Persist the MEK across page reloads.
 *     (Session storage would defeat the whole architecture — an attacker
 *      with file-system access would retrieve it. In-memory only is the
 *      correct tradeoff; the user re-unlocks on reload.)
 *   - Talk to the Supabase server.
 *     (Data-layer concerns belong in pages / hooks. This is pure key state.)
 *
 * Usage:
 *   <VaultProvider>
 *     <App />
 *   </VaultProvider>
 *
 *   function SomePage() {
 *     const { isUnlocked, encryptCredentials } = useVault();
 *     // ...
 *   }
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import { deriveMEK, generateVaultSalt, createVaultVerifier, verifyVaultPassword, isPasswordAcceptable, encryptString, decryptString } from '@/lib/vault';
import { deriveVerifierKey, deriveCredentialsKey, deriveTransactionsKey } from '@/lib/key-derivation';
import {
  encryptCredentials as encryptCredentialsFields,
  decryptCredentials as decryptCredentialsFields,
  encryptTransaction as encryptTransactionField,
  decryptTransaction as decryptTransactionField,
  type CredentialsPayload,
  type NormalizedTransaction,
} from '@/lib/crypto-fields';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

interface VaultSetupResult {
  /** Random per-user salt, base64. Store on the server as user_vault_meta.vault_salt. */
  saltB64: string;
  /** Verifier ciphertext. Store on the server as user_vault_meta.vault_verifier_ciphertext. */
  verifierCiphertext: string;
  /** Key version in use. Store as user_vault_meta.vault_key_version. */
  keyVersion: number;
}

interface VaultContextValue {
  /** True when a valid MEK is loaded in memory. */
  isUnlocked: boolean;
  /** Salt the current MEK was derived from. Needed to derive subkeys. */
  saltB64: string | null;

  /**
   * First-time vault setup. Generates a fresh salt, derives MEK, creates the
   * verifier ciphertext to store on the server. Does NOT persist — the caller
   * uploads the returned fields via Supabase.
   */
  setupVault(password: string): Promise<VaultSetupResult>;

  /**
   * Unlock the vault using the entered password + server-stored salt + verifier.
   * Returns true on success (MEK now in memory), false on wrong password.
   */
  unlock(password: string, saltB64: string, verifierCiphertext: string, keyVersion?: number): Promise<boolean>;

  /** Clear the MEK from memory. Subsequent encrypt/decrypt calls will throw. */
  lock(): void;

  /** Encrypt a credentials payload with the current user's credentials subkey. */
  encryptCredentials(payload: CredentialsPayload): Promise<string>;

  /** Decrypt a credentials ciphertext. Throws if vault is locked or key is wrong. */
  decryptCredentials(ciphertextB64: string): Promise<CredentialsPayload>;

  /**
   * Encrypt an arbitrary string of user content (labels, memos, error
   * messages). Uses the transactions subkey — same key the transaction
   * payloads use — so the same caller can decrypt everything with one
   * derived key. Do NOT use for credentials; use encryptCredentials.
   */
  encryptText(plaintext: string): Promise<string>;

  /** Decrypt a string previously produced by encryptText. */
  decryptText(ciphertextB64: string): Promise<string>;

  /** Encrypt a normalized transaction. */
  encryptTransaction(transaction: NormalizedTransaction): Promise<string>;

  /** Decrypt a transaction ciphertext. */
  decryptTransaction(ciphertextB64: string): Promise<NormalizedTransaction>;

  /**
   * Export the credentials subkey in raw form for a single in-transit handoff
   * to the sync edge function. The caller is responsible for never persisting
   * the returned bytes.
   */
  exportCredentialsKeyForSync(): Promise<string>;

  /** Same as above for the transactions subkey. */
  exportTransactionsKeyForSync(): Promise<string>;
}

// ------------------------------------------------------------------
// Context
// ------------------------------------------------------------------

const VaultContext = createContext<VaultContextValue | null>(null);

export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) {
    throw new Error('useVault must be called from within <VaultProvider>');
  }
  return ctx;
}

// ------------------------------------------------------------------
// Provider
// ------------------------------------------------------------------

interface VaultProviderProps {
  children: ReactNode;
}

export function VaultProvider({ children }: VaultProviderProps) {
  // We keep the MEK in a ref rather than state so changes don't cause re-renders
  // of the entire subtree every time we call encrypt/decrypt.
  const mekRef = useRef<CryptoKey | null>(null);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [saltB64, setSaltB64] = useState<string | null>(null);

  // ------------------------------------------------------------------
  // Setup: first-time vault creation.
  // ------------------------------------------------------------------
  const setupVault = useCallback(async (password: string): Promise<VaultSetupResult> => {
    const strength = isPasswordAcceptable(password);
    if (!strength.ok) {
      throw new Error(strength.reason);
    }

    const salt = generateVaultSalt();
    const mek = await deriveMEK(password, salt);
    const verifierKey = await deriveVerifierKey(mek, salt);
    const verifierCiphertext = await createVaultVerifier(verifierKey);

    mekRef.current = mek;
    setSaltB64(salt);
    setIsUnlocked(true);

    return {
      saltB64: salt,
      verifierCiphertext,
      keyVersion: 1,
    };
  }, []);

  // ------------------------------------------------------------------
  // Unlock: returning user.
  // ------------------------------------------------------------------
  const unlock = useCallback(async (
    password: string,
    storedSaltB64: string,
    verifierCiphertext: string,
    _keyVersion: number = 1,
  ): Promise<boolean> => {
    try {
      const mek = await deriveMEK(password, storedSaltB64);
      const verifierKey = await deriveVerifierKey(mek, storedSaltB64);
      const ok = await verifyVaultPassword(verifierKey, verifierCiphertext);
      if (!ok) return false;

      mekRef.current = mek;
      setSaltB64(storedSaltB64);
      setIsUnlocked(true);
      return true;
    } catch {
      // Any error (including wrong-password decryption failure) means unlock failed.
      return false;
    }
  }, []);

  // ------------------------------------------------------------------
  // Lock: clear the MEK.
  // ------------------------------------------------------------------
  const lock = useCallback(() => {
    mekRef.current = null;
    setSaltB64(null);
    setIsUnlocked(false);
  }, []);

  // ------------------------------------------------------------------
  // Encrypt / decrypt — gated on unlocked state.
  // ------------------------------------------------------------------
  const requireUnlocked = (): { mek: CryptoKey; saltB64: string } => {
    if (!mekRef.current || !saltB64) {
      throw new Error('Vault is locked. Call unlock() before encrypting or decrypting.');
    }
    return { mek: mekRef.current, saltB64 };
  };

  const encryptCredentials = useCallback(async (payload: CredentialsPayload): Promise<string> => {
    const { mek, saltB64 } = requireUnlocked();
    return encryptCredentialsFields(payload, mek, saltB64);
  }, [saltB64]);

  const decryptCredentials = useCallback(async (ciphertextB64: string): Promise<CredentialsPayload> => {
    const { mek, saltB64 } = requireUnlocked();
    return decryptCredentialsFields(ciphertextB64, mek, saltB64);
  }, [saltB64]);

  const encryptText = useCallback(async (plaintext: string): Promise<string> => {
    const { mek, saltB64 } = requireUnlocked();
    const key = await deriveTransactionsKey(mek, saltB64);
    return encryptString(plaintext, key);
  }, [saltB64]);

  const decryptText = useCallback(async (ciphertextB64: string): Promise<string> => {
    const { mek, saltB64 } = requireUnlocked();
    const key = await deriveTransactionsKey(mek, saltB64);
    return decryptString(ciphertextB64, key);
  }, [saltB64]);

  const encryptTransaction = useCallback(async (transaction: NormalizedTransaction): Promise<string> => {
    const { mek, saltB64 } = requireUnlocked();
    return encryptTransactionField(transaction, mek, saltB64);
  }, [saltB64]);

  const decryptTransaction = useCallback(async (ciphertextB64: string): Promise<NormalizedTransaction> => {
    const { mek, saltB64 } = requireUnlocked();
    return decryptTransactionField(ciphertextB64, mek, saltB64);
  }, [saltB64]);

  // ------------------------------------------------------------------
  // Raw subkey export (for a single sync-request handoff only).
  // ------------------------------------------------------------------
  const exportCredentialsKeyForSync = useCallback(async (): Promise<string> => {
    const { mek, saltB64 } = requireUnlocked();
    const key = await deriveCredentialsKey(mek, saltB64);
    const raw = await crypto.subtle.exportKey('raw', key);
    return arrayBufferToBase64(raw);
  }, [saltB64]);

  const exportTransactionsKeyForSync = useCallback(async (): Promise<string> => {
    const { mek, saltB64 } = requireUnlocked();
    const key = await deriveTransactionsKey(mek, saltB64);
    const raw = await crypto.subtle.exportKey('raw', key);
    return arrayBufferToBase64(raw);
  }, [saltB64]);

  // ------------------------------------------------------------------
  // Assemble the context value.
  // ------------------------------------------------------------------
  const value: VaultContextValue = {
    isUnlocked,
    saltB64,
    setupVault,
    unlock,
    lock,
    encryptCredentials,
    decryptCredentials,
    encryptText,
    decryptText,
    encryptTransaction,
    decryptTransaction,
    exportCredentialsKeyForSync,
    exportTransactionsKeyForSync,
  };

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// ------------------------------------------------------------------
// Note on subkey extractability
// ------------------------------------------------------------------
// The credentials and transactions subkeys are created extractable=true
// so they can be exported for in-transit handoff to the sync edge function.
// The verifier subkey is extractable=false — it never leaves the browser.
// See src/lib/vault.ts `importAesKey` vs `importAesKeyNonExtractable`.
