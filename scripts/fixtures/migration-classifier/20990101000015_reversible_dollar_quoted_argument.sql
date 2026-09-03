-- REVERSIBLE fixture for scripts/classify-migrations.mjs (OR-T1705).
--
-- A dollar quoted block used as a plain ARGUMENT, exactly the pg_cron
-- pattern this repo already schedules jobs with:
-- SELECT cron.schedule(name, schedule, $tag$...$tag$). Dollar quoting has
-- no meaning of its own outside CREATE FUNCTION ... AS and DO, so this is
-- an ordinary string constant, not a routine body and not a DO block. The
-- scheduled statement here is harmless, so the classifier must return
-- REVERSIBLE with ZERO findings instead of UNPARSEABLE.
--
-- This file is NOT a migration. It lives under scripts/fixtures and the 2099
-- version prefix cannot collide with a real one.

SELECT cron.schedule(
  'or_fixture_harmless_drain',
  '* * * * *',
  $cron$SELECT public.or_fixture_invoke_drain();$cron$
);
