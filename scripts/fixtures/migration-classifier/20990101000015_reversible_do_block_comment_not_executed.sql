-- REVERSIBLE fixture for scripts/classify-migrations.mjs (OR-T1709).
--
-- A DO block whose body contains nothing but a comment mentioning DROP
-- TABLE. Before OR-T1709 a DO block body was copied into the scan character
-- for character, never re-scrubbed, so this comment was read as executable
-- SQL and the file classified IRREVERSIBLE for a sentence that never ran.
--
-- This file is NOT a migration. It lives under scripts/fixtures and the 2099
-- version prefix cannot collide with a real one.

do $$
begin
  -- never DROP TABLE here, see the incident channel for why
  raise notice 'nothing to do';
end
$$;
