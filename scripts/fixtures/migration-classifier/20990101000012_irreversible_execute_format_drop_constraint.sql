-- FIXTURE, NOT A MIGRATION. Never applied: it lives outside supabase/migrations
-- and carries a year 2099 version prefix.
--
-- WHAT IT PROVES. The shape this repo actually writes: a constraint dropped
-- conditionally, inside an apply-time DO block, through format(). The statement
-- is written out in the file, so it is readable, and the existing ALTER TABLE
-- DROP rule catches it exactly as it catches the same statement written plainly.
--
-- Expected: IRREVERSIBLE, rule ALTER TABLE DROP.

DO $$
DECLARE
  check_name text;
BEGIN
  SELECT conname
    INTO check_name
    FROM pg_constraint
   WHERE conrelid = 'public.or_fixture_widget'::regclass
   LIMIT 1;

  IF check_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.or_fixture_widget DROP CONSTRAINT %I', check_name);
  END IF;
END $$;
