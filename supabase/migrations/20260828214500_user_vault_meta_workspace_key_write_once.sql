-- Pin public.user_vault_meta.workspace_key_id: unique, and write once.
--
-- Context: every policy on public.wrapped_data_keys resolves "who is the owner"
-- through user_vault_meta.workspace_key_id. The authenticated role holds UPDATE
-- on user_vault_meta and the update policy pins user_id only, so without the two
-- guards below any authenticated user can point their own row at a workspace key
-- they do not own and satisfy the owner clause of those policies.
--
-- Reversal:
--   DROP TRIGGER IF EXISTS trg_vault_workspace_key_write_once ON public.user_vault_meta;
--   DROP FUNCTION IF EXISTS public.enforce_vault_workspace_key_write_once();
--   ALTER TABLE public.user_vault_meta
--     DROP CONSTRAINT IF EXISTS user_vault_meta_workspace_key_id_key;

BEGIN;

-- 1. Refuse to proceed if the data would violate the constraint we are adding.
--    Checked rather than assumed: both projects read zero rows on 2026-08-28,
--    but a migration must not depend on when it happens to run.
DO $$
DECLARE
  dupes INTEGER;
BEGIN
  SELECT count(*) INTO dupes
    FROM (
      SELECT workspace_key_id
        FROM public.user_vault_meta
       WHERE workspace_key_id IS NOT NULL
       GROUP BY workspace_key_id
      HAVING count(*) > 1
    ) d;

  IF dupes > 0 THEN
    RAISE EXCEPTION
      'user_vault_meta.workspace_key_id already holds % duplicated non-null value(s); resolve them before applying this migration',
      dupes;
  END IF;
END;
$$;

-- 2. UNIQUE, so a second row cannot claim a workspace key that is already in use.
--    NULLs are unaffected: a unique index permits many.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.user_vault_meta'::regclass
       AND conname  = 'user_vault_meta_workspace_key_id_key'
  ) THEN
    ALTER TABLE public.user_vault_meta
      ADD CONSTRAINT user_vault_meta_workspace_key_id_key UNIQUE (workspace_key_id);
  END IF;
END;
$$;

-- 3. Write once, in the database, in the same shape as the existing
--    enforce_vault_pubkey_write_once guard on this table. A set value cannot be
--    changed, and it cannot be cleared to NULL first either, because NULL is
--    DISTINCT FROM the old value.
CREATE OR REPLACE FUNCTION public.enforce_vault_workspace_key_write_once()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF OLD.workspace_key_id IS NOT NULL
     AND NEW.workspace_key_id IS DISTINCT FROM OLD.workspace_key_id THEN
    RAISE EXCEPTION
      'user_vault_meta.workspace_key_id is write-once and cannot be changed once set';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_vault_workspace_key_write_once ON public.user_vault_meta;

CREATE TRIGGER trg_vault_workspace_key_write_once
  BEFORE UPDATE OF workspace_key_id ON public.user_vault_meta
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_vault_workspace_key_write_once();

COMMENT ON COLUMN public.user_vault_meta.workspace_key_id IS
  'Owner identity for every public.wrapped_data_keys policy. Allocated once by the first co-admin grant. UNIQUE and write-once in the database: it is not a secret, so nothing may let a caller choose it.';

-- 4. Assertions. A migration that applies is not evidence the control exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.user_vault_meta'::regclass
       AND conname  = 'user_vault_meta_workspace_key_id_key'
       AND contype  = 'u'
  ) THEN
    RAISE EXCEPTION 'assertion failed: UNIQUE constraint on user_vault_meta.workspace_key_id is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'enforce_vault_workspace_key_write_once'
  ) THEN
    RAISE EXCEPTION 'assertion failed: public.enforce_vault_workspace_key_write_once() is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.user_vault_meta'::regclass
       AND tgname  = 'trg_vault_workspace_key_write_once'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'assertion failed: trg_vault_workspace_key_write_once is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'enforce_vault_workspace_key_write_once'
       AND p.prosrc LIKE '%IS DISTINCT FROM OLD.workspace_key_id%'
  ) THEN
    RAISE EXCEPTION 'assertion failed: the write-once guard body does not compare workspace_key_id';
  END IF;
END;
$$;

COMMIT;
