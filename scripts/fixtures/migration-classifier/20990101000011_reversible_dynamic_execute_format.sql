-- FIXTURE, NOT A MIGRATION. Never applied: it lives outside supabase/migrations
-- and carries a year 2099 version prefix.
--
-- WHAT IT PROVES. Two things that must NOT be refused.
--
-- 1. An EXECUTE whose statement is written out in the file. The template is a
--    literal and its only placeholder is %I, which quotes the identifier it
--    interpolates, so an argument cannot introduce a statement of its own. The
--    SQL that will run is right here and it creates an index.
-- 2. GRANT EXECUTE names a privilege on a function. It runs nothing.
--
-- Expected: REVERSIBLE, with no findings at all.

DO $$
DECLARE
  idx text := 'or_fixture_widget_name_idx';
BEGIN
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.or_fixture_widget (name)', idx);
END $$;

GRANT EXECUTE ON FUNCTION public.or_fixture_noop() TO authenticated;
