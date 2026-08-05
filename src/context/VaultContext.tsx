/**
 * VaultContext , React state for the OrangeRails session-based vault.
 *
 * Holds the user's Master Encryption Key (MEK) in React state (which means,
 * in browser memory only, for the duration of this tab). When the vault is
 * "locked," the MEK is null and no encryption operations are possible.
 *
 * What this component does NOT do:
 *   - Persist the MEK across page reloads.
 *     (Session storage would defeat the whole architecture , an attacker
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

import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from "react";
import {
  deriveMEK,
  generateVaultSalt,
  createVaultVerifier,
  verifyVaultPassword,
  isPasswordAcceptable,
  encryptString,
  decryptString,
  generateMekBytes,
  importMekAsHkdf,
  deriveKek,
  wrapMekBytes,
  unwrapMekBytes,
  generateRecoveryCode,
  deriveRecoveryKek,
} from "@/lib/vault";
import {
  deriveVerifierKey,
  deriveCredentialsKey,
  deriveTransactionsKey,
  deriveBlindIndexKey,
} from "@/lib/key-derivation";
import {
  encryptCredentials as encryptCredentialsFields,
  decryptCredentials as decryptCredentialsFields,
  encryptTransaction as encryptTransactionField,
  decryptTransaction as decryptTransactionField,
  computeBlindIndex,
  type CredentialsPayload,
  type NormalizedTransaction,
} from "@/lib/crypto-fields";
import {
  ensurePqcKeypairs as ensurePqcKeypairsImpl,
  type EnsurePqcKeypairsResult,
  type SupabaseLike as PqcSupabaseLike,
} from "@/lib/pqc-lifecycle";
import {
  grantCoAdmin as grantCoAdminImpl,
  loadAdminSubkeysDirect,
  revokeCoAdmin as revokeCoAdminImpl,
  type AdminSubkeys,
} from "@/lib/co-admin";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

interface VaultSetupResult {
  /** Random per-user salt, base64. Store as user_vault_meta.vault_salt. */
  saltB64: string;
  /** Verifier ciphertext. Store as user_vault_meta.vault_verifier_ciphertext. */
  verifierCiphertext: string;
  /** Random MEK wrapped with Argon2id KEK. Store as user_vault_meta.enc_mek_ciphertext. */
  encMekCiphertext: string;
  /** Random MEK wrapped with recovery KEK. Store as user_vault_meta.recovery_ciphertext. */
  recoveryCiphertext: string;
  /** The plaintext recovery code , show once to the user, never persist. */
  recoveryCode: string;
  /** Key version: 2 = random MEK + Argon2id KEK (replaces v1: Argon2id-as-MEK). */
  keyVersion: number;
}

interface RecoveryResult {
  /** Updated MEK wrapper under the new password + existing salt. */
  newEncMekCiphertext: string;
  /** New recovery code (the old one is invalidated). */
  newRecoveryCode: string;
  /** Updated recovery ciphertext for the new code. */
  newRecoveryCiphertext: string;
}

interface VaultContextValue {
  /** True when a valid MEK is loaded in memory. */
  isUnlocked: boolean;
  /** Salt the current MEK was derived from. Needed to derive subkeys. */
  saltB64: string | null;

  /**
   * First-time vault setup. Generates a fresh salt, derives MEK, creates the
   * verifier ciphertext to store on the server. Does NOT persist , the caller
   * uploads the returned fields via Supabase.
   */
  setupVault(password: string): Promise<VaultSetupResult>;

  /**
   * Unlock the vault. Supports both key versions:
   *   v1 (legacy): MEK = Argon2id(password, salt) , pass encMekCiphertext=null.
   *   v2: MEK = unwrap(encMekCiphertext, Argon2id(password, salt) as KEK).
   * Returns true on success (MEK now in memory), false on wrong password.
   */
  unlock(
    password: string,
    saltB64: string,
    verifierCiphertext: string,
    keyVersion?: number,
    encMekCiphertext?: string | null,
  ): Promise<boolean>;

  /**
   * Recover access to the vault using the 12-word recovery code.
   * Unwraps the MEK, sets a new vault password (re-wraps with new password),
   * and generates a new recovery code. The caller must persist the returned
   * fields to user_vault_meta and show the new recovery code to the user.
   *
   * The vault salt is intentionally NOT changed , all HKDF subkeys (credentials,
   * transactions, PQC) remain valid because they depend on MEK + salt, and
   * neither changes.
   */
  recoverWithCode(params: {
    recoveryCode: string;
    recoveryCiphertext: string;
    saltB64: string;
    verifierCiphertext: string;
    newPassword: string;
  }): Promise<RecoveryResult>;

  /** Clear the MEK from memory. Subsequent encrypt/decrypt calls will throw. */
  lock(): void;

  /** Encrypt a credentials payload with the current user's credentials subkey. */
  encryptCredentials(payload: CredentialsPayload): Promise<string>;

  /** Decrypt a credentials ciphertext. Throws if vault is locked or key is wrong. */
  decryptCredentials(ciphertextB64: string): Promise<CredentialsPayload>;

  /**
   * Encrypt an arbitrary string of user content (labels, memos, error
   * messages). Uses the transactions subkey , same key the transaction
   * payloads use , so the same caller can decrypt everything with one
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

  /**
   * Generate the user's hybrid KEM + ML-DSA signing keypairs if they
   * don't exist yet, then publish public keys + MEK-wrapped secrets to
   * user_vault_meta. Idempotent , a second call is a no-op.
   *
   * Intended for invocation from the post-unlock path in a route that
   * already holds the Supabase client and user id. The future role-scoped
   * keys feature consumes this output.
   */
  ensurePqcKeypairs(supabase: PqcSupabaseLike, userId: string): Promise<EnsurePqcKeypairsResult>;

  // ------------------------------------------------------------------
  // Co-admin methods
  // ------------------------------------------------------------------

  /**
   * Grant full co-admin access to the user identified by targetEmail.
   * The owner's vault password is re-confirmed to derive subkeys as raw bytes.
   * Inserts rows into workspace_admins + wrapped_data_keys.
   */
  grantCoAdmin(params: {
    ownerUserId: string;
    ownerSaltB64: string;
    ownerPassword: string;
    targetEmail: string;
    existingKeyId: string | null;
    supabase: GrantSupabaseLike;
  }): Promise<{ workspaceKeyId: string }>;

  /**
   * Revoke a co-admin grant. Deletes workspace_admins + wrapped_data_keys rows.
   * RLS ensures only the owner can revoke.
   */
  revokeCoAdmin(params: {
    ownerWorkspaceKeyId: string;
    adminUserId: string;
    ownerUserId: string;
    supabase: GrantSupabaseLike;
  }): Promise<void>;

  /**
   * Load an owner's subkeys so the admin can decrypt their data.
   * The admin must already be unlocked.
   * Returns the two AES-GCM CryptoKeys for use in encrypt/decrypt operations.
   */
  loadAdminSubkeys(params: {
    ownerWorkspaceKeyId: string;
    wrappedCiphertextB64: string;
    kemSecretWrapped: string;
  }): Promise<AdminSubkeys>;

  /**
   * Compute a deterministic HMAC-SHA256 blind index for a plaintext value.
   *
   * Use this to populate hmac_* columns before inserting/updating rows, and
   * to build the WHERE clause value when querying by an encrypted field.
   * The value is normalized (trim + lowercase) before hashing so searches
   * are case-insensitive.
   *
   * Returns null for absent/empty values so callers can pass optional fields
   * directly without a null-guard.
   */
  blindIndex(value: string | null | undefined): Promise<string | null>;

  /**
   * Change the vault password. Re-wraps the MEK under the new password (same
   * salt , all HKDF subkeys remain valid) and generates a fresh recovery code.
   * Only supported for v2+ vaults (random MEK architecture).
   *
   * Caller must persist newEncMekCiphertext + newRecoveryCiphertext to
   * user_vault_meta and show newRecoveryCode to the user exactly once.
   */
  changeVaultPassword(params: {
    currentPassword: string;
    newPassword: string;
    storedSaltB64: string;
    storedEncMekCiphertext: string;
    storedVerifierCiphertext: string;
    keyVersion: number;
  }): Promise<{
    newEncMekCiphertext: string;
    newRecoveryCode: string;
    newRecoveryCiphertext: string;
  }>;
}

/** Narrow Supabase surface needed for grant/revoke operations. */
export interface GrantSupabaseLike {
  from(table: string): {
    select(cols: string): {
      eq(
        col: string,
        val: string,
      ): {
        maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: unknown }>;
        single(): Promise<{ data: Record<string, unknown> | null; error: unknown }>;
      };
    };
    insert(
      row: Record<string, unknown>,
    ): Promise<{ data: Record<string, unknown>[] | null; error: unknown }>;
    delete(): {
      eq(
        col: string,
        val: string,
      ): {
        eq(col: string, val: string): Promise<{ error: unknown }>;
        then(fn: (v: { error: unknown }) => void): Promise<{ error: unknown }>;
      };
    };
    update(vals: Record<string, unknown>): {
      eq(col: string, val: string): Promise<{ error: unknown }>;
    };
  };
  rpc(fn: string, params: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
}

// ------------------------------------------------------------------
// Context
// ------------------------------------------------------------------

const VaultContext = createContext<VaultContextValue | null>(null);

export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) {
    throw new Error("useVault must be called from within <VaultProvider>");
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
  // saltRef mirrors saltB64 state but is synchronous , setSaltB64 is batched by
  // React and won't be visible in the same call stack (e.g. ensurePqcKeypairs
  // called immediately after setupVault would see stale null). The ref is the
  // authoritative source for requireUnlocked(); state drives isUnlocked/UI only.
  const saltRef = useRef<string | null>(null);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [saltB64, setSaltB64] = useState<string | null>(null);

  // ------------------------------------------------------------------
  // Setup: first-time vault creation (v2 architecture).
  // MEK is random; password + recovery code each independently wrap it.
  // ------------------------------------------------------------------
  const setupVault = useCallback(async (password: string): Promise<VaultSetupResult> => {
    const strength = isPasswordAcceptable(password);
    if (!strength.ok) {
      throw new Error(strength.reason);
    }

    const salt = generateVaultSalt(); // 256-bit random salt

    // Generate a random MEK , this is the stable key for all data.
    const mekRaw = generateMekBytes();
    const mek = await importMekAsHkdf(mekRaw);

    // Wrap MEK with the Argon2id-derived KEK.
    const kek = await deriveKek(password, salt);
    const encMekCiphertext = await wrapMekBytes(mekRaw, kek);

    // Verifier: proves the password is correct on future unlocks.
    const verifierKey = await deriveVerifierKey(mek, salt);
    const verifierCiphertext = await createVaultVerifier(verifierKey);

    // Recovery code: independent second way to unwrap the same MEK.
    const recoveryCode = generateRecoveryCode();
    const recoveryKek = await deriveRecoveryKek(recoveryCode);
    const recoveryCiphertext = await wrapMekBytes(mekRaw, recoveryKek);

    mekRef.current = mek;
    saltRef.current = salt;
    setSaltB64(salt);
    setIsUnlocked(true);

    return {
      saltB64: salt,
      verifierCiphertext,
      encMekCiphertext,
      recoveryCiphertext,
      recoveryCode,
      keyVersion: 2,
    };
  }, []);

  // ------------------------------------------------------------------
  // Unlock: returning user. Handles v1 (legacy) and v2 (MEK wrapping).
  // ------------------------------------------------------------------
  const unlock = useCallback(
    async (
      password: string,
      storedSaltB64: string,
      verifierCiphertext: string,
      keyVersion: number = 1,
      encMekCiphertext: string | null = null,
    ): Promise<boolean> => {
      try {
        let mek: CryptoKey;

        if (keyVersion >= 2 && encMekCiphertext) {
          // v2: unwrap the random MEK using the Argon2id-derived KEK.
          const kek = await deriveKek(password, storedSaltB64);
          const mekRaw = await unwrapMekBytes(encMekCiphertext, kek);
          mek = await importMekAsHkdf(mekRaw);
        } else {
          // v1 legacy: MEK = Argon2id(password, salt) imported as HKDF.
          mek = await deriveMEK(password, storedSaltB64);
        }

        const verifierKey = await deriveVerifierKey(mek, storedSaltB64);
        const ok = await verifyVaultPassword(verifierKey, verifierCiphertext);
        if (!ok) return false;

        mekRef.current = mek;
        saltRef.current = storedSaltB64;
        setSaltB64(storedSaltB64);
        setIsUnlocked(true);
        return true;
      } catch {
        // Any error (including wrong-password decryption failure) means unlock failed.
        return false;
      }
    },
    [],
  );

  // ------------------------------------------------------------------
  // Recovery: regain access via the 12-word recovery code.
  // The vault salt is preserved so all existing HKDF subkeys stay valid.
  // ------------------------------------------------------------------
  const recoverWithCode = useCallback(
    async ({
      recoveryCode,
      recoveryCiphertext,
      saltB64: storedSalt,
      verifierCiphertext,
      newPassword,
    }: {
      recoveryCode: string;
      recoveryCiphertext: string;
      saltB64: string;
      verifierCiphertext: string;
      newPassword: string;
    }): Promise<RecoveryResult> => {
      // 1. Unwrap MEK with recovery code , throws if code is wrong.
      const recoveryKek = await deriveRecoveryKek(recoveryCode);
      const mekRaw = await unwrapMekBytes(recoveryCiphertext, recoveryKek);
      const mek = await importMekAsHkdf(mekRaw);

      // 2. Verify MEK matches the stored verifier (guards against swapped ciphertexts).
      const verifierKey = await deriveVerifierKey(mek, storedSalt);
      const ok = await verifyVaultPassword(verifierKey, verifierCiphertext);
      if (!ok) throw new Error("Recovery code does not match this vault.");

      // 3. Re-wrap MEK with the new password (same salt , subkeys stay valid).
      const newKek = await deriveKek(newPassword, storedSalt);
      const newEncMekCiphertext = await wrapMekBytes(mekRaw, newKek);

      // 4. Generate a fresh recovery code (old one is consumed/invalidated).
      const newRecoveryCode = generateRecoveryCode();
      const newRecoveryKek = await deriveRecoveryKek(newRecoveryCode);
      const newRecoveryCiphertext = await wrapMekBytes(mekRaw, newRecoveryKek);

      // 5. Load MEK into memory , vault is now unlocked.
      mekRef.current = mek;
      saltRef.current = storedSalt;
      setSaltB64(storedSalt);
      setIsUnlocked(true);

      return { newEncMekCiphertext, newRecoveryCode, newRecoveryCiphertext };
    },
    [],
  );

  // ------------------------------------------------------------------
  // Change password: re-wrap MEK under a new KEK, rotate recovery code.
  // ------------------------------------------------------------------
  const changeVaultPassword = useCallback(
    async ({
      currentPassword,
      newPassword,
      storedSaltB64: storedSalt,
      storedEncMekCiphertext,
      storedVerifierCiphertext,
      keyVersion,
    }: {
      currentPassword: string;
      newPassword: string;
      storedSaltB64: string;
      storedEncMekCiphertext: string;
      storedVerifierCiphertext: string;
      keyVersion: number;
    }) => {
      const strength = isPasswordAcceptable(newPassword);
      if (!strength.ok) throw new Error(strength.reason);

      if (keyVersion < 2 || !storedEncMekCiphertext) {
        throw new Error("Password change is not supported for legacy v1 vaults.");
      }

      // 1. Unwrap MEK with the current password's KEK.
      const currentKek = await deriveKek(currentPassword, storedSalt);
      const mekRaw = await unwrapMekBytes(storedEncMekCiphertext, currentKek);
      const mek = await importMekAsHkdf(mekRaw);

      // 2. Verify MEK is correct , guards against wrong current password.
      const verifierKey = await deriveVerifierKey(mek, storedSalt);
      const ok = await verifyVaultPassword(verifierKey, storedVerifierCiphertext);
      if (!ok) throw new Error("Current password is incorrect.");

      // 3. Re-wrap MEK with new KEK (same salt , all HKDF subkeys stay valid).
      const newKek = await deriveKek(newPassword, storedSalt);
      const newEncMekCiphertext = await wrapMekBytes(mekRaw, newKek);

      // 4. Fresh recovery code , old one is invalidated.
      const newRecoveryCode = generateRecoveryCode();
      const newRecoveryKek = await deriveRecoveryKek(newRecoveryCode);
      const newRecoveryCiphertext = await wrapMekBytes(mekRaw, newRecoveryKek);

      // 5. Keep vault unlocked with the same MEK in memory.
      mekRef.current = mek;

      return { newEncMekCiphertext, newRecoveryCode, newRecoveryCiphertext };
    },
    [],
  );

  // ------------------------------------------------------------------
  // Lock: clear the MEK.
  // ------------------------------------------------------------------
  const lock = useCallback(() => {
    mekRef.current = null;
    saltRef.current = null;
    setSaltB64(null);
    setIsUnlocked(false);
  }, []);

  // ------------------------------------------------------------------
  // Encrypt / decrypt , gated on unlocked state.
  // ------------------------------------------------------------------
  const requireUnlocked = (): { mek: CryptoKey; saltB64: string } => {
    if (!mekRef.current || !saltRef.current) {
      throw new Error("Vault is locked. Call unlock() before encrypting or decrypting.");
    }
    return { mek: mekRef.current, saltB64: saltRef.current };
  };

  const encryptCredentials = useCallback(
    async (payload: CredentialsPayload): Promise<string> => {
      const { mek, saltB64 } = requireUnlocked();
      return encryptCredentialsFields(payload, mek, saltB64);
    },
    [saltB64],
  );

  const decryptCredentials = useCallback(
    async (ciphertextB64: string): Promise<CredentialsPayload> => {
      const { mek, saltB64 } = requireUnlocked();
      return decryptCredentialsFields(ciphertextB64, mek, saltB64);
    },
    [saltB64],
  );

  const encryptText = useCallback(
    async (plaintext: string): Promise<string> => {
      const { mek, saltB64 } = requireUnlocked();
      const key = await deriveTransactionsKey(mek, saltB64);
      return encryptString(plaintext, key);
    },
    [saltB64],
  );

  const decryptText = useCallback(
    async (ciphertextB64: string): Promise<string> => {
      const { mek, saltB64 } = requireUnlocked();
      const key = await deriveTransactionsKey(mek, saltB64);
      return decryptString(ciphertextB64, key);
    },
    [saltB64],
  );

  const encryptTransaction = useCallback(
    async (transaction: NormalizedTransaction): Promise<string> => {
      const { mek, saltB64 } = requireUnlocked();
      return encryptTransactionField(transaction, mek, saltB64);
    },
    [saltB64],
  );

  const decryptTransaction = useCallback(
    async (ciphertextB64: string): Promise<NormalizedTransaction> => {
      const { mek, saltB64 } = requireUnlocked();
      return decryptTransactionField(ciphertextB64, mek, saltB64);
    },
    [saltB64],
  );

  // ------------------------------------------------------------------
  // Raw subkey export (for a single sync-request handoff only).
  // ------------------------------------------------------------------
  const exportCredentialsKeyForSync = useCallback(async (): Promise<string> => {
    const { mek, saltB64 } = requireUnlocked();
    const key = await deriveCredentialsKey(mek, saltB64);
    const raw = await crypto.subtle.exportKey("raw", key);
    return arrayBufferToBase64(raw);
  }, [saltB64]);

  const exportTransactionsKeyForSync = useCallback(async (): Promise<string> => {
    const { mek, saltB64 } = requireUnlocked();
    const key = await deriveTransactionsKey(mek, saltB64);
    const raw = await crypto.subtle.exportKey("raw", key);
    return arrayBufferToBase64(raw);
  }, [saltB64]);

  const ensurePqcKeypairs = useCallback(
    async (supabase: PqcSupabaseLike, userId: string): Promise<EnsurePqcKeypairsResult> => {
      const { mek, saltB64 } = requireUnlocked();
      return ensurePqcKeypairsImpl({ userId, mek, saltB64, supabase });
    },
    [saltB64],
  );

  // ------------------------------------------------------------------
  // Co-admin: grant.
  // ------------------------------------------------------------------
  const grantCoAdmin = useCallback(
    async (params: {
      ownerUserId: string;
      ownerSaltB64: string;
      ownerPassword: string;
      targetEmail: string;
      existingKeyId: string | null;
      supabase: GrantSupabaseLike;
    }) => {
      requireUnlocked(); // gate: vault must be unlocked
      const { targetEmail, supabase, ...rest } = params;

      // Resolve email → userId + kemPublicKey via SECURITY DEFINER RPC.
      const { data: rows, error: rpcErr } = await supabase.rpc("lookup_user_for_coadmin", {
        target_email: targetEmail,
      });
      if (rpcErr) {
        throw new Error((rpcErr as { message?: string }).message ?? "Lookup failed");
      }
      const row = (rows as { user_id: string; kem_public_key: string }[] | null)?.[0];
      if (!row) throw new Error("User not found or has not set up their vault yet");
      const targetUserId = row.user_id;
      const targetKemPubB64 = row.kem_public_key;

      // Fetch the owner's ML-DSA-65 signing secret (wrapped) to sign the grant
      // binding. This keeps app.tsx free of sig_secret_wrapped handling.
      const { data: sigRow } = await (supabase as any)
        .from("user_vault_meta")
        .select("sig_secret_wrapped")
        .eq("user_id", params.ownerUserId)
        .single();
      const ownerSigSecretWrapped = (sigRow as Record<string, unknown> | null)?.sig_secret_wrapped as string | undefined;
      if (!ownerSigSecretWrapped) {
        throw new Error(
          "Owner signing key not found. Ensure PQC vault setup is complete before granting co-admin access.",
        );
      }

      return grantCoAdminImpl({
        ...rest,
        ownerSigSecretWrapped,
        targetUserId,
        targetKemPubB64,
        supabase: supabase as unknown as Parameters<typeof grantCoAdminImpl>[0]["supabase"],
      });
    },
    [saltB64],
  );

  // ------------------------------------------------------------------
  // Co-admin: revoke.
  // ------------------------------------------------------------------
  const revokeCoAdmin = useCallback(
    async (params: {
      ownerWorkspaceKeyId: string;
      adminUserId: string;
      ownerUserId: string;
      supabase: GrantSupabaseLike;
    }) => {
      requireUnlocked();
      return revokeCoAdminImpl({
        ...params,
        supabase: params.supabase as unknown as Parameters<typeof revokeCoAdminImpl>[0]["supabase"],
      });
    },
    [saltB64],
  );

  // ------------------------------------------------------------------
  // Co-admin: load admin subkeys (consume flow).
  // ------------------------------------------------------------------
  const loadAdminSubkeys = useCallback(
    async (params: {
      ownerWorkspaceKeyId: string;
      wrappedCiphertextB64: string;
      kemSecretWrapped: string;
      grantSigB64: string | null;
      ownerSigPubB64: string;
      granteeUserId: string;
    }): Promise<AdminSubkeys> => {
      const { mek, saltB64: s } = requireUnlocked();
      return loadAdminSubkeysDirect({
        wrappedCiphertextB64: params.wrappedCiphertextB64,
        kemSecretWrapped: params.kemSecretWrapped,
        adminMek: mek,
        adminSaltB64: s,
        grantSigB64: params.grantSigB64,
        ownerSigPubB64: params.ownerSigPubB64,
        granteeUserId: params.granteeUserId,
        ownerWorkspaceKeyId: params.ownerWorkspaceKeyId,
      });
    },
    [saltB64],
  );

  // ------------------------------------------------------------------
  // Blind index , deterministic HMAC for server-side filtering.
  // ------------------------------------------------------------------
  const blindIndex = useCallback(
    async (value: string | null | undefined): Promise<string | null> => {
      const { mek, saltB64: s } = requireUnlocked();
      const hmacKey = await deriveBlindIndexKey(mek, s);
      return computeBlindIndex(value, hmacKey);
    },
    [saltB64],
  );

  // ------------------------------------------------------------------
  // Assemble the context value.
  // ------------------------------------------------------------------
  const value: VaultContextValue = {
    isUnlocked,
    saltB64,
    setupVault,
    unlock,
    recoverWithCode,
    lock,
    encryptCredentials,
    decryptCredentials,
    encryptText,
    decryptText,
    encryptTransaction,
    decryptTransaction,
    exportCredentialsKeyForSync,
    exportTransactionsKeyForSync,
    ensurePqcKeypairs,
    grantCoAdmin,
    revokeCoAdmin,
    loadAdminSubkeys,
    blindIndex,
    changeVaultPassword,
  };

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// ------------------------------------------------------------------
// Note on subkey extractability
// ------------------------------------------------------------------
// The credentials and transactions subkeys are created extractable=true
// so they can be exported for in-transit handoff to the sync edge function.
// The verifier subkey is extractable=false , it never leaves the browser.
// See src/lib/vault.ts `importAesKey` vs `importAesKeyNonExtractable`.
