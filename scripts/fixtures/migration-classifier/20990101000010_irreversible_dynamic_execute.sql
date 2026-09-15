-- FIXTURE, NOT A MIGRATION. Never applied: it lives outside supabase/migrations
-- and carries a year 2099 version prefix.
--
-- WHAT IT PROVES. A DO block runs when the migration is applied. This one builds
-- its statement at run time and hands it to EXECUTE, so the SQL that will run is
-- not in this file at all. The rules can see no DROP because there is no DROP
-- here to see, and "no finding" must not become "REVERSIBLE".
--
-- Expected: IRREVERSIBLE, rule DYNAMIC EXECUTE.

DO $$
DECLARE
  stmt text;
BEGIN
  stmt := current_setting('or.fixture_statement', true);
  EXECUTE stmt;
END $$;
