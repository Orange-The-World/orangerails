-- REVERSIBLE fixture: a DELETE with its own WHERE, where the WHERE sits after
-- a parenthesised subquery in a USING clause (OR-T2212).
--
-- WHAT THIS PINS. SELECT is itself a statement-start keyword, so a plain
-- forward scan for the next statement boundary reads the SELECT inside the
-- USING (SELECT ...) subquery as the boundary and misses the WHERE that comes
-- after it, on this exact DELETE. The scan must skip over parenthesised text
-- so a keyword inside a subquery is never mistaken for a statement boundary.
--
-- Expected: REVERSIBLE with zero findings.

delete from public.or_fixture_widget t
using (select id from public.or_fixture_other where flag) s
where t.id = s.id;
