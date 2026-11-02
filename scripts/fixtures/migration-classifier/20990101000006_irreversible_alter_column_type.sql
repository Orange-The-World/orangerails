-- IRREVERSIBLE fixture: ALTER COLUMN ... TYPE.
--
-- Expected verdict: IRREVERSIBLE, rule [ALTER COLUMN TYPE].
--
-- A widening is reversible and a narrowing is not, and this file cannot tell
-- you which one it is: the OLD type is not written here. text to varchar(64)
-- silently truncates every longer value. The classifier refuses the whole class
-- and names the reason, which is honest, rather than allowing a list of
-- "probably widening" targets and being wrong occasionally on production data.

alter table public.or_fixture_widget alter column label type varchar(64);
