-- 20260828170000_fix_vault_meta_delete_guard.sql
--
-- Make the user_vault_meta delete guard able to fire.
--
-- THE DEFECT
-- public.enforce_vault_meta_no_direct_delete is the BEFORE DELETE guard on
-- public.user_vault_meta, attached as trg_vault_meta_no_direct_delete by
-- 20260809140000_revoke_delete_vault_meta. Its whole body was:
--
--   IF pg_trigger_depth() = 0 THEN
--     RAISE EXCEPTION 'user_vault_meta rows cannot be deleted directly; ...';
--   END IF;
--   RETURN OLD;
--
-- pg_trigger_depth() returns the current trigger nesting level. It is 0 only
-- when you are NOT inside a trigger, and inside a trigger function it is at
-- least 1. The condition was therefore never true and the guard never raised.
-- The trigger was wired and was being invoked; it simply could not reach its
-- RAISE. A direct DELETE on user_vault_meta succeeded.
--
-- WHAT THIS WAS NOT, stated so the fix is not read as closing an open door.
-- Row level security applies to a non owner caller, no policy grants DELETE on
-- user_vault_meta to authenticated or anon, and after
-- 20260828160000 neither role holds the DELETE table privilege either. This was
-- a dead layer of defence in depth, not a live delete path for a browser client.
-- It is worth fixing because a control that cannot fire still reads as present.
--
-- THE MEASUREMENT THIS FIX RESTS ON
-- The depth a real cascade produces is an empirical question, so it was measured
-- rather than reasoned about. On the dev project, inside a transaction that was
-- rolled back, the guard was temporarily replaced by a function that only
-- recorded what it saw. The result:
--
--   direct DELETE on user_vault_meta   depth = 1, owning auth.users row visible
--   cascade from DELETE on auth.users  depth = 2, owning auth.users row gone
--
-- The cascade is deeper because ON DELETE CASCADE is implemented as an internal
-- referential integrity trigger on the parent, so this guard fires nested inside
-- it. The parent row is already removed by the time it fires.
--
-- THE FIX, AND WHY IT IS NOT JUST 0 CHANGED TO 1
-- Changing the test to pg_trigger_depth() = 1 would be correct on today's
-- measurement, but it is a bare nesting count: any future path that happened to
-- run two triggers deep would satisfy it and delete vault metadata silently.
-- So the guard also requires the thing it actually means, which is that the
-- owning account is gone. Both conditions were measured above.
--
-- It is written as an allow rule for the account removal cascade, with
-- everything else refused, rather than as a test for the one case to block.
-- That way an unanticipated path fails closed instead of open, which is the
-- correct direction for a guard on a self custody table.
--
-- auth.users is schema qualified because this function pins search_path to
-- public and pg_catalog.
--
-- The only path that removes these rows is the cascade: checked on dev, no
-- other function in schema public deletes from user_vault_meta.
--
-- Idempotent. CREATE OR REPLACE can be re-run.

CREATE OR REPLACE FUNCTION public.enforce_vault_meta_no_direct_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_catalog'
AS $fn$
BEGIN
  -- Allow exactly one thing: the account removal cascade. That is a delete
  -- arriving nested inside another trigger, whose owning auth.users row has
  -- already been removed in the same statement.
  IF pg_trigger_depth() > 1
     AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.user_id)
  THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'user_vault_meta rows cannot be deleted directly; deletion is only allowed via the account removal cascade';
END;
$fn$;

-- Prove what can be proved here without side effects.
--
-- Read this before assuming the assertions below are the whole verification,
-- because they are not and it would be dishonest to imply otherwise. A real
-- behavioural test needs a throwaway auth.users row, and a migration that
-- inserts into auth.users would run that insert on every environment it is ever
-- applied to, including production, where user creation triggers may exist that
-- do not exist on dev. That is not a side effect worth accepting inside a
-- migration, so the behavioural test was run separately against dev and its
-- result is recorded on the pull request:
--
--   direct DELETE   raises SQLSTATE P0001, the row survives
--   cascade DELETE  succeeds, the vault row is removed with the account
--
-- What is asserted here is the part that can be checked from the catalogue: that
-- the broken test is gone, that the corrected conditions are present, and that
-- the trigger carrying them is actually attached and enabled. The last one
-- matters most: a guard nobody attached is exactly as inert as a guard that
-- cannot fire, which is the defect being fixed.
DO $do$
DECLARE
  src text;
  tg_enabled char;
BEGIN
  SELECT prosrc INTO src
    FROM pg_proc
   WHERE oid = 'public.enforce_vault_meta_no_direct_delete'::regproc;

  IF src LIKE '%pg_trigger_depth() = 0%' THEN
    RAISE EXCEPTION
      'the guard still tests pg_trigger_depth() = 0, which can never be true inside a trigger';
  END IF;

  IF src NOT LIKE '%pg_trigger_depth() > 1%' THEN
    RAISE EXCEPTION 'the guard does not carry the corrected nesting test';
  END IF;

  IF src NOT LIKE '%auth.users%' THEN
    RAISE EXCEPTION 'the guard does not carry the owning row check';
  END IF;

  SELECT t.tgenabled INTO tg_enabled
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.oid = 'public.user_vault_meta'::regclass
     AND t.tgname = 'trg_vault_meta_no_direct_delete';

  IF tg_enabled IS NULL THEN
    RAISE EXCEPTION
      'trg_vault_meta_no_direct_delete is not attached to user_vault_meta, the guard is unreachable';
  END IF;

  IF tg_enabled = 'D' THEN
    RAISE EXCEPTION
      'trg_vault_meta_no_direct_delete is DISABLED, the guard is unreachable';
  END IF;
END;
$do$;
