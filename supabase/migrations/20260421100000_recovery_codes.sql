-- ============================================================
-- Vault key version 2: MEK wrapping + recovery codes.
-- ============================================================
-- Background: In v1, the vault password derives the MEK directly via
-- Argon2id (MEK = Argon2id(password, salt) imported as HKDF). There is
-- no way to change the vault password without re-encrypting all data.
--
-- In v2, the MEK is a random 32-byte key. The password-derived Argon2id
-- output is a KEK that *wraps* the MEK (enc_mek_ciphertext). A second
-- wrapping uses a recovery-code-derived KEK (recovery_ciphertext). This
-- lets the user change their password or recover access without touching
-- any encrypted data rows.
--
-- Existing rows (vault_key_version = 1) have NULL in both new columns
-- and continue to work via the v1 code path in VaultContext.ts. Users
-- will be migrated to v2 at next signup (new vaults start at v2) or via
-- a future in-app upgrade flow.
--
-- Wire format for both columns:
--   encryptString( base64(mekRaw), kek )
-- which produces: base64( IV[12] || AES-GCM-ciphertext || tag[16] )
-- See src/lib/vault.ts: wrapMekBytes / unwrapMekBytes.

ALTER TABLE public.user_vault_meta
  ADD COLUMN IF NOT EXISTS enc_mek_ciphertext  TEXT,
  ADD COLUMN IF NOT EXISTS recovery_ciphertext TEXT;

COMMENT ON COLUMN public.user_vault_meta.enc_mek_ciphertext IS
  'Random MEK (32 bytes) wrapped with Argon2id(password, vault_salt). '
  'Null for v1 vaults. v2+ vaults always populate this.';

COMMENT ON COLUMN public.user_vault_meta.recovery_ciphertext IS
  'Random MEK wrapped with a recovery-code-derived KEK (HKDF of the 12-word code). '
  'Null for v1 vaults. Required for recovery-code reset of vault password.';
