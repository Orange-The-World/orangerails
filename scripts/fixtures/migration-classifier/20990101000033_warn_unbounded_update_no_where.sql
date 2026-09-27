-- WARNING fixture: UPDATE with no WHERE clause.
--
-- Expected verdict: REVERSIBLE, zero findings (the OR-T1537 ruling, option C,
-- warns rather than refuses an unbounded UPDATE: the row still exists
-- afterward, unlike a DROP or an unqualified DELETE).
-- Expected warning: UNBOUNDED_WRITE.
--
-- The two REVERSIBLE-with-no-warning fixtures alongside this one pin the two
-- ways a real WHERE clause must NOT be missed: spanning a newline, and
-- sitting after a comment.

update public.or_fixture_widget set enabled = false;
