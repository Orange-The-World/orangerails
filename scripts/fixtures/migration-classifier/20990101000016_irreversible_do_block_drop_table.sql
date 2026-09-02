-- IRREVERSIBLE fixture for scripts/classify-migrations.mjs (OR-T1709).
--
-- A DO block whose body contains a real DROP TABLE, alongside a comment
-- mentioning DROP TABLE that must NOT be what fires the rule. Proves the
-- OR-T1709 fix (re-scrubbing a DO block body) still catches a genuine
-- irreversible statement and does not buy quiet by weakening the scan.
--
-- This file is NOT a migration. It lives under scripts/fixtures and the 2099
-- version prefix cannot collide with a real one.

do $$
begin
  -- never DROP TABLE here, see the incident channel for why
  drop table public.or_fixture_do_block_widget;
end
$$;
