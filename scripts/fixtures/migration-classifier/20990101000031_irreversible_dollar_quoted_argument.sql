-- IRREVERSIBLE fixture for scripts/classify-migrations.mjs (OR-T1705).
--
-- The mirror image of the reversible dollar quoted argument fixture: the
-- statement pg_cron would run every minute, forever, contains a TRUNCATE.
--
-- Before OR-T1705 the classifier could not name this dollar quoted block at
-- all (it is neither a routine body nor a DO block) and returned UNPARSEABLE
-- for the WHOLE FILE, so this was only ever treated as irreversible by
-- accident, not by detection. Now the block is read as the string constant
-- it is and its contents are scanned under the same rules as ordinary SQL,
-- so this must return IRREVERSIBLE, rule TRUNCATE, reported at the line
-- inside the literal.
--
-- This file is NOT a migration. It lives under scripts/fixtures and the 2099
-- version prefix cannot collide with a real one.

SELECT cron.schedule(
  'or_fixture_dangerous_drain',
  '* * * * *',
  $cron$TRUNCATE public.or_fixture_scratch;$cron$
);
