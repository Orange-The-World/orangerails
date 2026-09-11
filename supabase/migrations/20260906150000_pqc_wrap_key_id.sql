-- 20260906150000_pqc_wrap_key_id.sql
--
-- Record which version of the PQC secret-wrap derivation sealed
-- kem_secret_wrapped and sig_secret_wrapped, so a decrypt failure on those
-- two columns can be told apart from a version mismatch before it is ever
-- read as "this secret is dead".
--
-- WHY THIS EXISTS (OR-T2093, follow-up to OR-T2069 and OR-T1995)
-- rewrapPqcSecretKey (src/lib/pqc-lifecycle.ts) treats an AES-GCM
-- authentication tag failure on these two columns as "the secret is dead",
-- and the caller (VaultContext.recoverWithCode) converts "dead" into
-- clearing the matching public key, which discards a keypair permanently.
-- That reading is correct only when the wrap key handed in is provably the
-- key the stored ciphertext was sealed under. assertPqcWrapKeyMatchesSalt
-- proves the handed key is self-consistent with the salt the CALLER names;
-- it cannot prove the handed key opens the STORED ciphertext, and only that
-- second proposition tells "dead" apart from "wrong key". A future salt
-- rotation whose migration moves every other ciphertext on this table but
-- misses these two, or a bump to derivePqcSecretWrapKey's HKDF context,
-- would pass the self-consistency check, fail the tag check, and silently
-- destroy a live keypair on every recovery.
--
-- THE FIX. Stamp which wrap-key version sealed the ciphertext at the moment
-- it is written (buildPqcKeyMaterial) or last carried across a rotation
-- (carryPqcSecretsAcrossRotation), and refuse to treat a tag failure as
-- "dead" unless the stored stamp matches the version the code derives
-- today. A mismatch means the derivation moved, not that the secret is
-- gone, and it is caught before the ambiguous tag failure is even
-- attempted, not after.
--
-- BACKFILL. Every PQC secret in this database today, on dev and on prod,
-- was wrapped by derivePqcSecretWrapKey under HKDF_CONTEXTS.
-- ORANGERAILS_PQC_SECRET_WRAP_V1 (src/lib/key-derivation.ts), the only
-- derivation that has ever existed, applied to each vault's own vault_salt,
-- which OR-T1995 traced as never having rotated. That is
-- CURRENT_PQC_WRAP_KEY_ID = 1 in src/lib/pqc-lifecycle.ts. DEFAULT 1 on
-- ADD COLUMN backfills every existing row with the value that is already
-- true of it; nothing is reclassified.
--
-- PRIVILEGE. Stated explicitly, not inherited, matching every column added
-- to this table since 20260828163000 (dev's per-column allow list): the
-- table level grant to authenticated is SELECT only, so a client reading
-- its own row already sees this column, and INSERT/UPDATE must be named
-- per column for the client to be able to write it. anon is not named.
--
-- IDEMPOTENT. ADD COLUMN IF NOT EXISTS, a repeatable COMMENT, a repeatable
-- GRANT. A re-run is a no-op.
--
-- REVERSIBLE while the application code that reads this column has not
-- shipped:
--   ALTER TABLE public.user_vault_meta DROP COLUMN IF EXISTS pqc_wrap_key_id;
-- Once carryPqcSecretsAcrossRotation depends on it, dropping it removes the
-- guard this migration exists to add, not merely a column.
--
-- Refs: OR-T2093, OR-T2069, OR-T1995

BEGIN;

ALTER TABLE public.user_vault_meta
  ADD COLUMN IF NOT EXISTS pqc_wrap_key_id integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.user_vault_meta.pqc_wrap_key_id IS
  'Which version of derivePqcSecretWrapKey (HKDF_CONTEXTS.ORANGERAILS_PQC_SECRET_WRAP_V1 applied to this row''s vault_salt) sealed kem_secret_wrapped and sig_secret_wrapped. Stamped by buildPqcKeyMaterial when the secrets are first written and re-stamped by carryPqcSecretsAcrossRotation whenever both are successfully carried across an MEK rotation. Compared against CURRENT_PQC_WRAP_KEY_ID (src/lib/pqc-lifecycle.ts) before an AES-GCM tag failure on either wrapped column is ever read as this secret is dead: a mismatch means the derivation changed, not that the secret is gone. OR-T2093.';

GRANT INSERT (pqc_wrap_key_id), UPDATE (pqc_wrap_key_id)
  ON TABLE public.user_vault_meta TO authenticated;

-- Prove the result inside this transaction or abort.
DO $assert$
DECLARE
  v_type text;
  v_nullable text;
  v_default text;
  v_anon_col int;
BEGIN
  SELECT data_type, is_nullable, column_default
    INTO v_type, v_nullable, v_default
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'user_vault_meta'
     AND column_name = 'pqc_wrap_key_id';

  IF v_type IS NULL THEN
    RAISE EXCEPTION 'FAIL: public.user_vault_meta.pqc_wrap_key_id was not created';
  END IF;
  IF v_type <> 'integer' THEN
    RAISE EXCEPTION 'FAIL: pqc_wrap_key_id must be integer, got %', v_type;
  END IF;
  IF v_nullable <> 'NO' THEN
    RAISE EXCEPTION 'FAIL: pqc_wrap_key_id must be NOT NULL. A row with a wrapped PQC secret and no recorded wrap-key version is exactly the ambiguity this column exists to remove.';
  END IF;
  IF v_default IS NULL THEN
    RAISE EXCEPTION 'FAIL: pqc_wrap_key_id must have a default so existing rows backfill to the version that already applies to them, got none';
  END IF;

  IF NOT has_column_privilege('authenticated', 'public.user_vault_meta', 'pqc_wrap_key_id', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL: authenticated cannot SELECT pqc_wrap_key_id, so a client could not read the version it must check before treating a rewrap failure as dead';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.user_vault_meta', 'pqc_wrap_key_id', 'INSERT') THEN
    RAISE EXCEPTION 'FAIL: authenticated cannot INSERT pqc_wrap_key_id';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.user_vault_meta', 'pqc_wrap_key_id', 'UPDATE') THEN
    RAISE EXCEPTION 'FAIL: authenticated cannot UPDATE pqc_wrap_key_id, so a rotation could never re-stamp it';
  END IF;

  SELECT count(*)
    INTO v_anon_col
    FROM pg_attribute a
   WHERE a.attrelid = 'public.user_vault_meta'::regclass
     AND a.attname = 'pqc_wrap_key_id'
     AND a.attacl::text LIKE '%anon=%';
  IF v_anon_col <> 0 THEN
    RAISE EXCEPTION 'FAIL: a column level grant to anon exists on pqc_wrap_key_id. The anonymous role must never be named on this column.';
  END IF;

  RAISE NOTICE 'OR-T2093 ok: user_vault_meta.pqc_wrap_key_id is integer, not null, defaulted, writable by authenticated, no anon column grant';
END $assert$;

COMMIT;
