-- ============================================================
-- kem_public_key write-once guard (DL-0620)
-- ============================================================
-- A member's KEM public key is the anchor other members wrap data
-- keys against. Once it is set it must never silently change or be
-- cleared: a swapped key would let a fresh keypair be substituted for
-- the real recipient, breaking the custody guarantee.
--
-- This migration adds a BEFORE UPDATE row trigger to both
-- user_vault_meta and customer_vault_meta that refuses any UPDATE
-- which would change a NON-NULL kem_public_key to a different value or
-- to NULL. The first write (NULL to value) stays allowed, so normal
-- vault initialisation is unaffected.
--
-- Additive and reversible: DROP the two triggers and the function to
-- undo. No existing rows are read or written.

CREATE OR REPLACE FUNCTION public.enforce_kem_public_key_write_once()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.kem_public_key IS NOT NULL
     AND NEW.kem_public_key IS DISTINCT FROM OLD.kem_public_key THEN
    RAISE EXCEPTION
      'kem_public_key is write-once: it cannot be changed or cleared once set'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_kem_public_key_write_once() IS
  'DL-0620: refuses any UPDATE that would change a non-NULL kem_public_key to a different value or to NULL. NULL to value (first set) is allowed.';

DROP TRIGGER IF EXISTS trg_user_vault_meta_kem_write_once ON public.user_vault_meta;
CREATE TRIGGER trg_user_vault_meta_kem_write_once
  BEFORE UPDATE ON public.user_vault_meta
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_kem_public_key_write_once();

DROP TRIGGER IF EXISTS trg_customer_vault_meta_kem_write_once ON public.customer_vault_meta;
CREATE TRIGGER trg_customer_vault_meta_kem_write_once
  BEFORE UPDATE ON public.customer_vault_meta
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_kem_public_key_write_once();
