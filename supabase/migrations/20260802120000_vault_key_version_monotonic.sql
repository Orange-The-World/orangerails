-- Migration: enforce monotonic vault_key_version on user_vault_meta
--
-- vault_key_version must only ever increase (or stay the same). Rolling it
-- back would let a passive attacker silently downgrade a user's vault to an
-- older, potentially weaker wrapping scheme. PostgreSQL CHECK constraints
-- cannot compare NEW vs OLD, so we use a BEFORE UPDATE trigger instead.
--
-- Safe to re-run: function uses CREATE OR REPLACE, trigger uses DROP IF EXISTS.

CREATE OR REPLACE FUNCTION public.vault_key_version_must_not_decrease()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.vault_key_version < OLD.vault_key_version THEN
    RAISE EXCEPTION
      'vault_key_version must not decrease (current: %, proposed: %)',
      OLD.vault_key_version, NEW.vault_key_version
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vault_key_version_monotonic ON public.user_vault_meta;

CREATE TRIGGER trg_vault_key_version_monotonic
  BEFORE UPDATE OF vault_key_version ON public.user_vault_meta
  FOR EACH ROW
  EXECUTE FUNCTION public.vault_key_version_must_not_decrease();

-- Enforce the same monotonic constraint on customer_vault_meta
DROP TRIGGER IF EXISTS trg_vault_key_version_monotonic ON public.customer_vault_meta;

CREATE TRIGGER trg_vault_key_version_monotonic
  BEFORE UPDATE OF vault_key_version ON public.customer_vault_meta
  FOR EACH ROW
  EXECUTE FUNCTION public.vault_key_version_must_not_decrease();

-- DOWN
DROP TRIGGER IF EXISTS trg_vault_key_version_monotonic ON public.customer_vault_meta;
DROP TRIGGER IF EXISTS trg_vault_key_version_monotonic ON public.user_vault_meta;
DROP FUNCTION IF EXISTS public.vault_key_version_must_not_decrease();
