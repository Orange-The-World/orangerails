-- ============================================================
-- Verification for DL-0620 kem_public_key write-once guard
-- ============================================================
-- There is no pgTAP / SQL test harness in this repo (tests are Deno
-- tests for edge functions), so this is a MANUAL script for QA/DBA.
-- Run it against a database, e.g.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/kem_public_key_write_once.verify.sql
--
-- Expected results:
--   * Parent commit, guard NOT applied  -> RED: a forbidden UPDATE
--     succeeds, so the script RAISES 'GUARD MISSING ...' and exits
--     non-zero. This proves the negatives are not vacuous.
--   * With the migration applied         -> GREEN: the script runs to
--     'ALL ASSERTIONS PASSED' with no error.
--
-- The whole script runs in one transaction and ROLLBACKs, so it leaves
-- no fixture rows behind.
--
-- Note for the DBA landing this: the two auth.users seed rows use the
-- standard Supabase column set. If the live auth schema differs,
-- adjust ONLY the two INSERT INTO auth.users blocks; the three
-- assertion blocks are the contract and must not change.

BEGIN;

-- --- Fixture -------------------------------------------------------
-- Row 1: kem already set (used for the two refusal cases).
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password,
                        created_at, updated_at)
VALUES ('00000000-0000-0000-0000-000000000000',
        '0d062000-0000-0000-0000-000000000001',
        'authenticated', 'authenticated',
        'dl0620-writeonce@test.invalid', '',
        now(), now());

INSERT INTO public.user_vault_meta (user_id, vault_salt, vault_verifier_ciphertext, kem_public_key)
VALUES ('0d062000-0000-0000-0000-000000000001', 'salt', 'verifier', 'ORIGINAL_KEM_PUBKEY');

-- Row 2: kem still NULL (used for the allowed first-set case).
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password,
                        created_at, updated_at)
VALUES ('00000000-0000-0000-0000-000000000000',
        '0d062000-0000-0000-0000-000000000002',
        'authenticated', 'authenticated',
        'dl0620-firstset@test.invalid', '',
        now(), now());

INSERT INTO public.user_vault_meta (user_id, vault_salt, vault_verifier_ciphertext)
VALUES ('0d062000-0000-0000-0000-000000000002', 'salt', 'verifier');

-- --- Case A: value -> different value must be REFUSED --------------
DO $$
BEGIN
  BEGIN
    UPDATE public.user_vault_meta
      SET kem_public_key = 'DIFFERENT_KEM_PUBKEY'
      WHERE user_id = '0d062000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'GUARD MISSING (case A): value->different UPDATE was allowed';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'case A OK: value->different refused';
  END;
END $$;

-- --- Case B: value -> NULL must be REFUSED -------------------------
DO $$
BEGIN
  BEGIN
    UPDATE public.user_vault_meta
      SET kem_public_key = NULL
      WHERE user_id = '0d062000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'GUARD MISSING (case B): value->NULL UPDATE was allowed';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'case B OK: value->NULL refused';
  END;
END $$;

-- --- Case C: NULL -> value (first set) must be ALLOWED -------------
-- A regression here (guard wrongly refusing first init) raises
-- check_violation, which is uncaught and fails the script.
DO $$
BEGIN
  UPDATE public.user_vault_meta
    SET kem_public_key = 'FIRST_TIME_KEM'
    WHERE user_id = '0d062000-0000-0000-0000-000000000002';
  RAISE NOTICE 'case C OK: NULL->value (first set) allowed';
END $$;

-- --- customer_vault_meta shares the same trigger function ----------
-- Assert the trigger is actually attached to the customer table too,
-- so the guard covers both surfaces, not just user_vault_meta.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.customer_vault_meta'::regclass
      AND tgname = 'trg_customer_vault_meta_kem_write_once'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'GUARD MISSING: trigger not attached to customer_vault_meta';
  END IF;
  RAISE NOTICE 'customer_vault_meta OK: write-once trigger attached';
END $$;

DO $$ BEGIN RAISE NOTICE 'ALL ASSERTIONS PASSED'; END $$;

ROLLBACK;
