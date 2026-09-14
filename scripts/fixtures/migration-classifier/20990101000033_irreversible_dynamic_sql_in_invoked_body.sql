-- Fixture for scripts/classify-migrations.mjs (OR-T1715 / OR-T2363).
--
-- A body this migration invokes builds its SQL at run time. The scrub that
-- runs before a body is scanned blanks every string literal, so the EXECUTE
-- below reaches the rules as the bare word "execute" with nothing after it.
--
-- This is not a gap. The general DYNAMIC EXECUTE rule (executeIsUnreadable)
-- runs on every scanned statement, including the statements of a routine
-- body that classifySql proves is invoked (OR-T1658), because both paths
-- funnel through the same applyRules/RULES list. A bare "execute" with a
-- blanked argument is exactly what executeIsUnreadable flags: the argument
-- is empty, readablePiece('') is false, so the EXECUTE is unreadable and the
-- statement is refused.
--
-- This fixture exists to PROVE that live, not to add new code: it was
-- written to close the same hole PR #1172 patched on a since-dead branch of
-- the migration-classifier stack, and running it against current dev shows
-- the hole was already closed by the general rule before #1172 could land.
-- See OR-T2363 for the full trace.
--
-- Expected: IRREVERSIBLE, rule DYNAMIC EXECUTE, reported at the BEGIN line
-- of the invoked body (the same line convention as fixtures 23/24/28/29:
-- PL/pgSQL has no semicolon between BEGIN and the first statement, so the
-- statement, and the finding, start at BEGIN).
--
-- This file is NOT a migration. It lives under scripts/fixtures and the 2099
-- version prefix cannot collide with a real one.

create or replace function public.or_fixture_dynamic_wipe()
returns void
language plpgsql
as $$
begin
  execute 'drop table public.or_fixture_widget';
end;
$$;

select public.or_fixture_dynamic_wipe();
