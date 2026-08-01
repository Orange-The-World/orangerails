-- Write-once enforcement for the post-quantum KEM public key.
--
-- kem_public_key on user_vault_meta and customer_vault_meta is the public key
-- that other clients encrypt to. Once a user has registered a value, it must
-- not be silently replaced by a different value, nor cleared back to NULL. If
-- it could be, a party with UPDATE reach on the row could substitute key
-- material of their choosing for the key clients trust, which is the exact
-- server-side substitution the zero-knowledge design exists to prevent.
--
-- The RLS UPDATE policies on both tables carry a USING clause with no
-- WITH CHECK, so any principal whose row passes the ownership predicate can
-- rewrite any column of that row, kem_public_key included. A column-scoped
-- privilege revoke does not cover a SECURITY DEFINER or service-role caller, so
-- the durable guard is a trigger, which fires for every role, service_role and
-- postgres included.
--
-- Semantics of the trigger (UPDATE only):
--   NULL      -> value            permitted   (first registration)
--   value     -> same value       permitted   (idempotent re-write)
--   value     -> different value  refused     (substitution)
--   value     -> NULL             refused     (clearing)
-- The UPDATE guard is gated on a real change (OLD is not null AND NEW is
-- distinct from OLD), so first registration and an identical re-write pass.
-- DELETE is intentionally not guarded: client roles have no DELETE policy on
-- either table (RLS), so a client-path delete-and-reinsert attack is already
-- blocked. A trigger-level DELETE guard would fire for service_role and CASCADE
-- deletes too, making rows with a registered key permanently undeletable by
-- anyone, including the erasure path needed for GDPR Art. 17 account deletion.
-- If an explicit audit trail for key-bearing row deletion is needed later, that
-- is a separate feature with an authorized erasure path designed from the start.
--
-- No rotation path is included, on purpose. A legitimate key swap needs a proof
-- that the user, not the server, authorized it, and the protocol does not yet
-- define that proof. A rotation function authorized by database role alone
-- would hand back the substitution capability this migration removes, so it is
-- worse than no door. Rotation lands as its own migration once the protocol
-- defines the user-authorized proof. This omission is deliberate, not an
-- oversight. This is not a one-way door: a later migration can add a properly
-- gated rotation path.
--
-- Idempotent: CREATE OR REPLACE for the function, DROP TRIGGER IF EXISTS before
-- each CREATE TRIGGER, and each table block is guarded on the column being
-- present so a project missing it is skipped rather than failing the run.
--
-- Reversible, run as postgres:
--   DROP TRIGGER IF EXISTS trg_user_vault_meta_kem_write_once ON public.user_vault_meta;
--   DROP TRIGGER IF EXISTS trg_customer_vault_meta_kem_write_once ON public.customer_vault_meta;
--   DROP FUNCTION IF EXISTS public.enforce_kem_public_key_write_once();

BEGIN;

-- Plain trigger function, invoker rights (NOT security definer): it adds no
-- elevated capability, it only refuses a disallowed change.
CREATE OR REPLACE FUNCTION public.enforce_kem_public_key_write_once()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.kem_public_key IS NOT NULL
       AND NEW.kem_public_key IS DISTINCT FROM OLD.kem_public_key THEN
      RAISE EXCEPTION
        'kem_public_key is write-once and cannot be changed once set (%.%)',
        TG_TABLE_SCHEMA, TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.user_vault_meta'::regclass
      AND attname = 'kem_public_key'
      AND attnum > 0
      AND NOT attisdropped
  ) THEN
    DROP TRIGGER IF EXISTS trg_user_vault_meta_kem_write_once ON public.user_vault_meta;
    CREATE TRIGGER trg_user_vault_meta_kem_write_once
      BEFORE UPDATE ON public.user_vault_meta
      FOR EACH ROW
      EXECUTE FUNCTION public.enforce_kem_public_key_write_once();
  ELSE
    RAISE NOTICE 'skipped user_vault_meta: kem_public_key column not present';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.customer_vault_meta'::regclass
      AND attname = 'kem_public_key'
      AND attnum > 0
      AND NOT attisdropped
  ) THEN
    DROP TRIGGER IF EXISTS trg_customer_vault_meta_kem_write_once ON public.customer_vault_meta;
    CREATE TRIGGER trg_customer_vault_meta_kem_write_once
      BEFORE UPDATE ON public.customer_vault_meta
      FOR EACH ROW
      EXECUTE FUNCTION public.enforce_kem_public_key_write_once();
  ELSE
    RAISE NOTICE 'skipped customer_vault_meta: kem_public_key column not present';
  END IF;
END
$$;

COMMIT;
