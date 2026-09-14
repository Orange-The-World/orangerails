-- FIXTURE, NOT A MIGRATION. Never applied: it lives outside supabase/migrations
-- and carries a year 2099 version prefix.
--
-- WHAT THIS PINS, and it is the OPPOSITE direction from 20990101000016. A
-- string literal inside a DO block body is usually not prose. It is the
-- statement EXECUTE is about to run, and it is the only readable copy of that
-- statement anywhere in the file. It must stay.
--
-- Blanking literals inside a DO body the way they are blanked at the top level
-- flattens this file to EXECUTE, no rule matches, and it classifies REVERSIBLE
-- while it drops a table on apply. That is the direction the header of
-- classify-migrations.mjs forbids: never conclude REVERSIBLE from an absence.
--
-- So this file is green before the DO body scrub and green after it. It is a
-- control, not a regression test: it exists so that the fix for the comment
-- case in 20990101000016 cannot be bought by blanking literals as well.
--
-- Expected: IRREVERSIBLE [DROP TABLE].

DO $$
BEGIN
  EXECUTE 'drop table public.or_fixture_widget';
END $$;
