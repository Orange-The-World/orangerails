-- Account removal must clear public.customer_vault_meta, and customer_vault_meta
-- needs the delete guard public.user_vault_meta already has.
--
-- Reversal:
--   DROP TRIGGER IF EXISTS trg_clear_customer_vault_meta_on_account_removal ON auth.users;
--   DROP TRIGGER IF EXISTS trg_customer_vault_meta_no_direct_delete ON public.customer_vault_meta;
--   DROP FUNCTION IF EXISTS public.clear_customer_vault_meta_on_account_removal();
--   DROP FUNCTION IF EXISTS public.enforce_customer_vault_meta_no_direct_delete();

BEGIN;

-- 1. The delete guard customer_vault_meta does not have.
--
--    Written in the shape that can actually fire: inside a BEFORE DELETE trigger
--    pg_trigger_depth() is always at least 1, so a guard that tests for depth 0
--    permits every delete. This one permits a delete only when it arrives through
--    another statement (depth > 1) AND the owning account is already gone, which
--    covers both legitimate paths: a customers row being deleted (the row is gone,
--    so the join finds nothing) and an account being removed (the trigger below
--    nulls auth_user_id first, so the join finds nothing).
--
--    SECURITY DEFINER because the guard reads auth.users and the caller on the
--    customers cascade path is not guaranteed to hold SELECT there. It only reads.
CREATE OR REPLACE FUNCTION public.enforce_customer_vault_meta_no_direct_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF pg_trigger_depth() > 1
     AND NOT EXISTS (
       SELECT 1
         FROM public.customers cc
         JOIN auth.users uu ON uu.id = cc.auth_user_id
        WHERE cc.id = OLD.customer_id
     )
  THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'customer_vault_meta rows cannot be deleted directly; they are removed when the owning account or customer is removed';
END;
$function$;

DROP TRIGGER IF EXISTS trg_customer_vault_meta_no_direct_delete ON public.customer_vault_meta;

CREATE TRIGGER trg_customer_vault_meta_no_direct_delete
  BEFORE DELETE ON public.customer_vault_meta
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_customer_vault_meta_no_direct_delete();

-- 2. Account removal clears the customer vault meta.
--
--    Deliberately NOT done by changing customers.auth_user_id to ON DELETE
--    CASCADE: whether the customers row itself may be destroyed is a retention
--    question that is not settled. This removes the vault meta only.
--
--    SECURITY DEFINER because neither authenticated nor service_role holds DELETE
--    on public.customer_vault_meta, which is intended and stays that way.
CREATE OR REPLACE FUNCTION public.clear_customer_vault_meta_on_account_removal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  ids uuid[];
BEGIN
  SELECT array_agg(cc.id) INTO ids
    FROM public.customers cc
   WHERE cc.auth_user_id = OLD.id;

  IF ids IS NULL THEN
    RETURN OLD;
  END IF;

  -- Do explicitly, and FIRST, what the foreign key would do a moment later
  -- (customers.auth_user_id is ON DELETE SET NULL). The order is load bearing:
  -- it is what makes the guard above see an owner that is already gone.
  UPDATE public.customers
     SET auth_user_id = NULL
   WHERE id = ANY(ids);

  DELETE FROM public.customer_vault_meta
   WHERE customer_id = ANY(ids);

  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS trg_clear_customer_vault_meta_on_account_removal ON auth.users;

CREATE TRIGGER trg_clear_customer_vault_meta_on_account_removal
  BEFORE DELETE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.clear_customer_vault_meta_on_account_removal();

-- 3. Assertions. A migration that applies is not evidence a control exists, and
--    the trigger on auth.users in particular depends on privileges this role may
--    not hold in every environment. Fail loudly rather than silently.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.customer_vault_meta'::regclass
       AND tgname  = 'trg_customer_vault_meta_no_direct_delete'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'assertion failed: trg_customer_vault_meta_no_direct_delete is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'auth.users'::regclass
       AND tgname  = 'trg_clear_customer_vault_meta_on_account_removal'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'assertion failed: trg_clear_customer_vault_meta_on_account_removal is missing on auth.users';
  END IF;

  -- The depth test is the whole point: a guard written against depth 0 can never
  -- fire from inside a BEFORE DELETE trigger. Assert the body, not just the name.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'enforce_customer_vault_meta_no_direct_delete'
       AND p.prosrc LIKE '%pg_trigger_depth() > 1%'
  ) THEN
    RAISE EXCEPTION 'assertion failed: the customer_vault_meta delete guard does not test pg_trigger_depth() > 1';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'clear_customer_vault_meta_on_account_removal'
       AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'assertion failed: clear_customer_vault_meta_on_account_removal is missing or is not SECURITY DEFINER';
  END IF;
END;
$$;

COMMIT;
