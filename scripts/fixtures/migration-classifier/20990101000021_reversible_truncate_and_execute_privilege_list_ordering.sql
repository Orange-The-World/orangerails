-- REVERSIBLE fixture: TRUNCATE and EXECUTE named as a privilege inside a
-- comma separated GRANT/REVOKE list, not as the first privilege in the list
-- (OR-T2212).
--
-- WHAT THIS PINS. Postgres privilege lists are comma separated and the order
-- is arbitrary, so `GRANT SELECT, TRUNCATE ...` and `GRANT USAGE, EXECUTE
-- ...` name a privilege exactly as much as `GRANT TRUNCATE ...` and `GRANT
-- EXECUTE ...` do. An anchor that only recognises the guarded word
-- IMMEDIATELY after GRANT or REVOKE, with nothing else, misses it the moment
-- another privilege sits first in the list, and reads a harmless privilege
-- grant as a TRUNCATE that empties a table or a dynamic EXECUTE that runs
-- unreadable SQL.
--
-- Expected: REVERSIBLE with zero findings.

grant select, truncate on public.or_fixture_widget to authenticated;
revoke insert, truncate on public.or_fixture_widget from authenticated;

grant usage, execute on function public.or_fixture_cleanup() to authenticated;
revoke select, execute on function public.or_fixture_cleanup() from authenticated;
