-- 20991231000000_or_t1176_negative_control_do_not_merge.sql
-- TEMPORARY. Negative control for OR-T1176: this migration declares a
-- -- Requires: version that has no matching file anywhere in this tree, so
-- the new migration-dependency check must fail this pull request. Removed
-- in the very next commit on this branch once the red run is captured.
-- Requires: 20990101000000
select 1;
