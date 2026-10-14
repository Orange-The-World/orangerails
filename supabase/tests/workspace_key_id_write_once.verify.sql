-- ============================================================
-- Verification for OR-T0805 / DEV-0364
-- UNIQUE + write-once on public.user_vault_meta.workspace_key_id
-- ============================================================
-- There is no pgTAP harness in this repo. This is a MANUAL script for the
-- DBA. A migration that applies is not evidence the control works.
--
-- Run it against a database, e.g.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/workspace_key_id_write_once.verify.sql
-- or paste the whole file into the project's SQL editor. It is safe: the
-- whole script is one transaction and ROLLBACKs, so it leaves no fixture
-- rows behind. Do not run it against production as a write probe if you
-- only needed a catalogue read; the catalogue checks are the first block
-- and are SELECT-only until the fixture begins.
--
-- Expected results:
--   * Guard NOT applied  -> RED: a forbidden UPDATE succeeds, so the
--     script RAISES 'GUARD MISSING ...' and exits non-zero.
--   * Guard applied      -> GREEN: the script runs to
--     'ALL ASSERTIONS PASSED' with no error.
--
-- THE AUTHENTICATED CASE IS THE LOAD-BEARING ONE. Catalogue presence of
-- the constraint and the trigger is necessary and not sufficient. The
-- attack OR-T0805 names is an authenticated non-owner writing a known
-- workspace_key_id into their own user_vault_meta row. That is Case E.
-- Cases A-D run as the current role (typically postgres / the SQL editor)
-- so the unique constraint and the trigger are exercised even when the
-- authenticated role no longer holds a column privilege on
-- workspace_key_id (that privilege was revoked later; unique and
-- write-once still have to hold for service_role and SECURITY DEFINER).
--
-- If Case E is refused with SQLSTATE 42501, that is still a refusal of
-- the attack. If it is refused with 23505, the unique constraint is what
-- stopped it. If the UPDATE matches zero rows, that is NOT a refusal: it
-- means auth.uid() did not stick and RLS hid the row. The script treats
-- that as a broken fixture, not a pass.
--
-- Note for the DBA landing this: the two auth.users seed rows use the
-- same column set as supabase/tests/kem_public_key_write_once.verify.sql.
-- If the live auth schema differs, adjust ONLY the two INSERT INTO
-- auth.users blocks; the assertion blocks are the contract.

BEGIN;

-- --- Catalogue -----------------------------------------------------
-- Acceptance reads these two objects back from pg_constraint / pg_indexes
-- and pg_trigger. Fail here before writing any fixture, so a project that
-- has not applied 20260828214500 is a missing-object failure rather than
-- a GUARD MISSING on a table that was never pinned.

DO $$
DECLARE
  n integer;
  trig pg_trigger%ROWTYPE;
BEGIN
  SELECT count(*) INTO n
    FROM pg_constraint
   WHERE conrelid = 'public.user_vault_meta'::regclass
     AND conname  = 'user_vault_meta_workspace_key_id_key'
     AND contype  = 'u';

  IF n <> 1 THEN
    RAISE EXCEPTION
      'GUARD MISSING: UNIQUE constraint user_vault_meta_workspace_key_id_key is not on public.user_vault_meta (pg_constraint rows=%)',
      n;
  END IF;
  RAISE NOTICE 'catalogue OK: UNIQUE constraint user_vault_meta_workspace_key_id_key';

  -- A unique INDEX with a different name would also satisfy the ticket's
  -- "pg_constraint or pg_indexes" readback. The migration created a
  -- constraint, so the constraint name is the one we pin. If someone
  -- later replaces it with an index, this block must be updated rather
  -- than silently accepting a differently named object.

  SELECT count(*) INTO n
    FROM (
      SELECT workspace_key_id
        FROM public.user_vault_meta
       WHERE workspace_key_id IS NOT NULL
       GROUP BY workspace_key_id
      HAVING count(*) > 1
    ) d;
  IF n > 0 THEN
    RAISE EXCEPTION
      'data would violate the unique constraint: % duplicated non-null workspace_key_id value(s)',
      n;
  END IF;
  RAISE NOTICE 'catalogue OK: no duplicated non-null workspace_key_id values';

  SELECT * INTO trig
    FROM pg_trigger
   WHERE tgrelid = 'public.user_vault_meta'::regclass
     AND tgname  = 'trg_vault_workspace_key_write_once'
     AND NOT tgisinternal;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'GUARD MISSING: trigger trg_vault_workspace_key_write_once is not on public.user_vault_meta';
  END IF;

  -- tgtype bits: 2 = BEFORE, 64 = UPDATE, 1 = ROW. The migration creates
  -- BEFORE UPDATE OF workspace_key_id FOR EACH ROW.
  IF (trig.tgtype & 2) = 0 THEN
    RAISE EXCEPTION 'GUARD MISSING: trg_vault_workspace_key_write_once is not BEFORE';
  END IF;
  IF (trig.tgtype & 64) = 0 THEN
    RAISE EXCEPTION 'GUARD MISSING: trg_vault_workspace_key_write_once is not an UPDATE trigger';
  END IF;
  IF (trig.tgtype & 1) = 0 THEN
    RAISE EXCEPTION 'GUARD MISSING: trg_vault_workspace_key_write_once is not FOR EACH ROW';
  END IF;
  RAISE NOTICE 'catalogue OK: trg_vault_workspace_key_write_once is BEFORE UPDATE FOR EACH ROW';

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace nsp ON nsp.oid = p.pronamespace
     WHERE nsp.nspname = 'public'
       AND p.proname = 'enforce_vault_workspace_key_write_once'
       AND p.prosrc LIKE '%IS DISTINCT FROM OLD.workspace_key_id%'
  ) THEN
    RAISE EXCEPTION
      'GUARD MISSING: enforce_vault_workspace_key_write_once() does not compare workspace_key_id';
  END IF;
  RAISE NOTICE 'catalogue OK: enforce_vault_workspace_key_write_once compares workspace_key_id';
END $$;

-- --- Fixture -------------------------------------------------------
-- Row 1: workspace_key_id already set (used for write-once and as the
-- stolen value the non-owner will try to claim).
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password,
                        created_at, updated_at)
VALUES ('00000000-0000-0000-0000-000000000000',
        '0d080500-0000-0000-0000-000000000001',
        'authenticated', 'authenticated',
        'or-t0805-owner@test.invalid', '',
        now(), now());

INSERT INTO public.user_vault_meta (user_id, vault_salt, vault_verifier_ciphertext)
VALUES ('0d080500-0000-0000-0000-000000000001', 'or-t0805-salt', 'or-t0805-verifier');

-- Row 2: workspace_key_id still NULL (the authenticated non-owner).
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password,
                        created_at, updated_at)
VALUES ('00000000-0000-0000-0000-000000000000',
        '0d080500-0000-0000-0000-000000000002',
        'authenticated', 'authenticated',
        'or-t0805-attacker@test.invalid', '',
        now(), now());

INSERT INTO public.user_vault_meta (user_id, vault_salt, vault_verifier_ciphertext)
VALUES ('0d080500-0000-0000-0000-000000000002', 'or-t0805-salt', 'or-t0805-verifier');

-- --- Case A: NULL -> value (first set) must be ALLOWED -------------
-- A regression here (guard wrongly refusing first init) is uncaught and
-- fails the script. This is also how the stolen value gets onto the
-- owner row for the cases below.
DO $$
BEGIN
  UPDATE public.user_vault_meta
     SET workspace_key_id = '0d080500-0000-0000-0000-00000000aaaa'
   WHERE user_id = '0d080500-0000-0000-0000-000000000001';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fixture failed: owner row was not updated on first set';
  END IF;
  RAISE NOTICE 'case A OK: NULL->value (first set) allowed';
END $$;

-- --- Case B: value -> different value must be REFUSED --------------
DO $$
BEGIN
  BEGIN
    UPDATE public.user_vault_meta
       SET workspace_key_id = '0d080500-0000-0000-0000-00000000bbbb'
     WHERE user_id = '0d080500-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'GUARD MISSING (case B): value->different UPDATE was allowed';
  EXCEPTION
    WHEN check_violation OR raise_exception THEN
      IF SQLERRM LIKE 'GUARD MISSING%' THEN
        RAISE;
      END IF;
      IF SQLERRM NOT LIKE '%write-once%' THEN
        RAISE EXCEPTION
          'case B refused, but not by the write-once guard (got: %)',
          SQLERRM;
      END IF;
      RAISE NOTICE 'case B OK: value->different refused (% / %)', SQLSTATE, SQLERRM;
  END;
END $$;

-- --- Case C: value -> NULL must be REFUSED -------------------------
-- Clearing to NULL and then writing a different value would bypass a
-- write-once guard that only compared non-null to non-null. The
-- migration uses IS DISTINCT FROM, so NULL is also a change.
DO $$
BEGIN
  BEGIN
    UPDATE public.user_vault_meta
       SET workspace_key_id = NULL
     WHERE user_id = '0d080500-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'GUARD MISSING (case C): value->NULL UPDATE was allowed';
  EXCEPTION
    WHEN check_violation OR raise_exception THEN
      IF SQLERRM LIKE 'GUARD MISSING%' THEN
        RAISE;
      END IF;
      IF SQLERRM NOT LIKE '%write-once%' THEN
        RAISE EXCEPTION
          'case C refused, but not by the write-once guard (got: %)',
          SQLERRM;
      END IF;
      RAISE NOTICE 'case C OK: value->NULL refused (% / %)', SQLSTATE, SQLERRM;
  END;
END $$;

-- --- Case D: second row claims an in-use id must be REFUSED --------
-- This is the unique constraint. The attacker row is still NULL, so
-- write-once does not fire; unique is the only thing that can stop it
-- for a role that is allowed to write the column.
DO $$
BEGIN
  BEGIN
    UPDATE public.user_vault_meta
       SET workspace_key_id = '0d080500-0000-0000-0000-00000000aaaa'
     WHERE user_id = '0d080500-0000-0000-0000-000000000002';
    RAISE EXCEPTION
      'GUARD MISSING (case D): a second row was allowed to claim an in-use workspace_key_id';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'case D OK: duplicate workspace_key_id refused (% / %)', SQLSTATE, SQLERRM;
    WHEN raise_exception THEN
      IF SQLERRM LIKE 'GUARD MISSING%' THEN
        RAISE;
      END IF;
      RAISE EXCEPTION
        'case D refused, but not by unique_violation (got % / %)',
        SQLSTATE, SQLERRM;
  END;
END $$;

-- --- Case E: authenticated non-owner claims the owner's id ---------
-- SET LOCAL so both the role and the jwt claims die with this
-- transaction. SET ROLE inside a DO block would be restored when that
-- block ended, which would make the UPDATE run as postgres and pass
-- the unique test as "the owner" of the session, not as the attacker.
-- The jwt claims have to be set BEFORE the role change so auth.uid()
-- reads the attacker, not null.

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"0d080500-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
SELECT set_config('request.jwt.claim.sub',  '0d080500-0000-0000-0000-000000000002', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

DO $$
DECLARE
  got uuid;
BEGIN
  got := auth.uid();
  IF got IS DISTINCT FROM '0d080500-0000-0000-0000-000000000002'::uuid THEN
    RAISE EXCEPTION
      'fixture failed (case E): auth.uid() is %; jwt claims did not stick. A 0-row UPDATE would look like a refusal and prove nothing',
      got;
  END IF;
END $$;

SET LOCAL ROLE authenticated;

DO $$
DECLARE
  n integer;
BEGIN
  BEGIN
    UPDATE public.user_vault_meta
       SET workspace_key_id = '0d080500-0000-0000-0000-00000000aaaa'
     WHERE user_id = '0d080500-0000-0000-0000-000000000002';

    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE EXCEPTION
        'GUARD MISSING (case E): authenticated non-owner UPDATE claimed the owner workspace_key_id (% row(s))',
        n;
    END IF;
    -- 0 rows and no error: RLS hid the row, which means auth.uid() did
    -- not match. The check above should have caught that. Fail closed.
    RAISE EXCEPTION
      'fixture failed (case E): UPDATE matched 0 rows under role authenticated. Not a refusal.';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE
        'case E OK: authenticated non-owner refused with insufficient_privilege (% / %)',
        SQLSTATE, SQLERRM;
    WHEN unique_violation THEN
      RAISE NOTICE
        'case E OK: authenticated non-owner refused with unique_violation (% / %)',
        SQLSTATE, SQLERRM;
    WHEN check_violation OR raise_exception THEN
      IF SQLERRM LIKE 'GUARD MISSING%' OR SQLERRM LIKE 'fixture failed%' THEN
        RAISE;
      END IF;
      RAISE NOTICE
        'case E OK: authenticated non-owner refused (% / %)',
        SQLSTATE, SQLERRM;
  END;
END $$;

RESET ROLE;

DO $$ BEGIN RAISE NOTICE 'ALL ASSERTIONS PASSED'; END $$;

ROLLBACK;
