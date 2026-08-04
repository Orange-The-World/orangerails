-- ============================================================
-- DL-0610: write-once guard on user_vault_meta public key columns.
-- ============================================================
-- The ML-DSA-65 signing public key (sig_public_key) and the hybrid KEM
-- public key (kem_public_key) are the trust root for signature
-- verification on the co-admin add-member path (DL-0619). Row-level
-- security already limits UPDATE on user_vault_meta to the owning user
-- (user_id = auth.uid()), but RLS does not stop a service-role actor,
-- which is the adversary the zero-knowledge model is defined against.
--
-- This trigger makes both public key columns write-once: once a column
-- holds a non-null value it can never be changed to a different value,
-- by anyone, including the owner. The initial NULL to value write is
-- allowed so vault creation still works.
--
-- A write-once UPDATE guard is not enough on its own: a service-role
-- actor could DELETE the row and re-INSERT it with an attacker key,
-- laundering a key change through delete plus insert. So direct DELETE
-- of a user_vault_meta row is also blocked. Legitimate account deletion
-- still works because it arrives as an ON DELETE CASCADE from
-- auth.users, which runs at trigger depth greater than zero; a direct
-- DELETE runs at depth zero and is rejected.
--
-- search_path is pinned on both functions so an unqualified name cannot
-- be resolved against a caller-controlled search_path.
--
-- Idempotent: CREATE OR REPLACE plus DROP TRIGGER IF EXISTS, so a
-- re-apply is a no-op. Restore path:
--   DROP TRIGGER trg_vault_pubkey_write_once ON public.user_vault_meta;
--   DROP TRIGGER trg_vault_meta_no_direct_delete ON public.user_vault_meta;
--   DROP FUNCTION public.enforce_vault_pubkey_write_once();
--   DROP FUNCTION public.enforce_vault_meta_no_direct_delete();

CREATE OR REPLACE FUNCTION public.enforce_vault_pubkey_write_once()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF OLD.sig_public_key IS NOT NULL
     AND NEW.sig_public_key IS DISTINCT FROM OLD.sig_public_key THEN
    RAISE EXCEPTION
      'user_vault_meta.sig_public_key is write-once and cannot be changed once set';
  END IF;

  IF OLD.kem_public_key IS NOT NULL
     AND NEW.kem_public_key IS DISTINCT FROM OLD.kem_public_key THEN
    RAISE EXCEPTION
      'user_vault_meta.kem_public_key is write-once and cannot be changed once set';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vault_pubkey_write_once ON public.user_vault_meta;
CREATE TRIGGER trg_vault_pubkey_write_once
  BEFORE UPDATE ON public.user_vault_meta
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_vault_pubkey_write_once();

CREATE OR REPLACE FUNCTION public.enforce_vault_meta_no_direct_delete()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $$
BEGIN
  IF pg_trigger_depth() = 0 THEN
    RAISE EXCEPTION
      'user_vault_meta rows cannot be deleted directly; deletion is only allowed via the account removal cascade';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_vault_meta_no_direct_delete ON public.user_vault_meta;
CREATE TRIGGER trg_vault_meta_no_direct_delete
  BEFORE DELETE ON public.user_vault_meta
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_vault_meta_no_direct_delete();

-- Drop the predecessor that guarded kem_public_key only; superseded by this migration.
-- #542 targeted enforce_kem_public_key_write_once() which is removed here; close that PR.
DROP TRIGGER IF EXISTS trg_user_vault_meta_kem_write_once ON public.user_vault_meta;
DROP FUNCTION IF EXISTS public.enforce_kem_public_key_write_once();
