-- REVERSIBLE fixture: an UPDATE whose WHERE clause sits after a comment.
--
-- Expected: REVERSIBLE, zero findings, zero warnings. The comment is blanked
-- by scrub() before statements are split, so it must not be read as
-- statement text and must not hide the WHERE that follows it.

update public.or_fixture_widget
set enabled = false
-- only the widgets flagged for cleanup
where id = 1;
