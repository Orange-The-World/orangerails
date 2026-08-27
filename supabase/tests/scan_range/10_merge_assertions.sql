-- Merge and refusal assertions for public.record_stealth_scan_range (DL-1856).
--
-- Every case uses its OWN connection id, so one case leaking state cannot
-- make another pass. Expectations are the full normalized range set, never a
-- row count: a count says "1" to both [100,200] and [100,250], which is the
-- exact distinction under test.
--
-- Height arithmetic being pinned here, from the migration:
--   a stored range [a,b] merges with a new [f,t] when  a <= t + 1  AND  b >= f - 1
-- so a one-block gap does NOT merge and a zero-block gap DOES. Cases 3, 4 and
-- 8 sit either side of that line.

-- Step 0. Prove the migrations actually took effect before asserting anything
-- about behaviour. Without this, a suite that ran against an empty database
-- would fail with "function does not exist" in a way that reads like an
-- environment problem, or worse, a future refactor could leave the unguarded
-- overload in place and nothing here would notice.
DO $$
BEGIN
  IF to_regprocedure('public.record_stealth_scan_range(uuid,int,int,text)') IS NULL THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: the guarded 4-arg record_stealth_scan_range does not exist. The migrations did not load, so nothing below would have tested anything.';
  END IF;

  IF to_regprocedure('public.record_stealth_scan_range(uuid,int,int)') IS NOT NULL THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: the unguarded 3-arg record_stealth_scan_range overload still exists. The owner guard can be bypassed by calling it directly.';
  END IF;

  RAISE NOTICE 'ok  precondition  ->  guarded 4-arg function present, 3-arg overload absent';
END $$;

BEGIN;

INSERT INTO public.stealth_connections (id, app_user_id) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'user-a'),
  ('00000000-0000-0000-0000-0000000000a2', 'user-a'),
  ('00000000-0000-0000-0000-0000000000a3', 'user-a'),
  ('00000000-0000-0000-0000-0000000000a4', 'user-a'),
  ('00000000-0000-0000-0000-0000000000a5', 'user-a'),
  ('00000000-0000-0000-0000-0000000000a6', 'user-a'),
  ('00000000-0000-0000-0000-0000000000a7', 'user-a'),
  ('00000000-0000-0000-0000-0000000000a8', 'user-a'),
  ('00000000-0000-0000-0000-0000000000a9', NULL);

-- Case 1. Empty table: a plain insert, nothing to merge with.
SELECT public.record_stealth_scan_range('00000000-0000-0000-0000-0000000000a1', 100, 200, 'user-a');
SELECT public.t_assert_ranges('1 plain insert into an empty set',
       '00000000-0000-0000-0000-0000000000a1', '[100,200]');

-- Case 2. OVERLAPPING ranges merge into one.
SELECT public.record_stealth_scan_range('00000000-0000-0000-0000-0000000000a1', 150, 250, 'user-a');
SELECT public.t_assert_ranges('2 overlapping merges',
       '00000000-0000-0000-0000-0000000000a1', '[100,250]');

-- Case 3. ADJACENT above, the +1 boundary: [100,200] then [201,300].
SELECT public.record_stealth_scan_range('00000000-0000-0000-0000-0000000000a2', 100, 200, 'user-a');
SELECT public.record_stealth_scan_range('00000000-0000-0000-0000-0000000000a2', 201, 300, 'user-a');
SELECT public.t_assert_ranges('3 adjacent above merges at the +1 boundary',
       '00000000-0000-0000-0000-0000000000a2', '[100,300]');

-- Case 4. ADJACENT below, the -1 boundary: [100,200] then [50,99].
SELECT public.record_stealth_scan_range('00000000-0000-0000-0000-0000000000a3', 100, 200, 'user-a');
SELECT public.record_stealth_scan_range('00000000-0000-0000-0000-0000000000a3', 50, 99, 'user-a');
SELECT public.t_assert_ranges('4 adjacent below merges at the -1 boundary',
       '00000000-0000-0000-0000-0000000000a3', '[50,200]');

-- Case 5. CONTAINED: a new range entirely inside an existing one changes
-- nothing. The set must not grow and the bounds must not move.
SELECT public.record_stealth_scan_range('00000000-0000-0000-0000-0000000000a4', 100, 200, 'user-a');
SELECT public.record_stealth_scan_range('00000000-0000-0000-0000-0000000000a4', 120, 180, 'user-a');
SELECT public.t_assert_ranges('5 contained range is absorbed, bounds unchanged',
       '00000000-0000-0000-0000-0000000000a4', '[100,200]');

-- Case 6. CONTAINING: the other direction. A new range that swallows an
-- existing one must leave the wider range, not the narrower one.
SELECT public.record_stealth_scan_range('00000000-0000-0000-0000-0000000000a5', 120, 180, 'user-a');
SELECT public.record_stealth_scan_range('00000000-0000-0000-0000-0000000000a5', 100, 200, 'user-a');
SELECT public.t_assert_ranges('6 containing range replaces the narrower one',
       '00000000-0000-0000-0000-0000000000a5', '[100,200]');

-- Case 7. OUT OF ORDER, and it BRIDGES. Insert the high range first, then the
-- low one, then the gap between them. The third call must collapse all three
-- into a single range. This is the case a naive "merge with the last range"
-- implementation gets wrong.
SELECT public.record_stealth_scan_range('00000000-0000-0000-0000-0000000000a6', 300, 400, 'user-a');
SELECT public.record_stealth_scan_range('00000000-0000-0000-0000-0000000000a6', 100, 200, 'user-a');
SELECT public.t_assert_ranges('7a out of order, two disjoint ranges held in order',
       '00000000-0000-0000-0000-0000000000a6', '[100,200] [300,400]');
SELECT public.record_stealth_scan_range('00000000-0000-0000-0000-0000000000a6', 201, 299, 'user-a');
SELECT public.t_assert_ranges('7b the bridging range collapses both into one',
       '00000000-0000-0000-0000-0000000000a6', '[100,400]');

-- Case 8. THE CONTROL, and the reason the seven cases above mean anything.
-- A one-block gap must NOT merge. An implementation that merges everything it
-- is handed passes every positive case above; only this one catches it. 201
-- merges (case 3) and 202 does not, one height apart, which is the tightest
-- place to pin the boundary.
SELECT public.record_stealth_scan_range('00000000-0000-0000-0000-0000000000a7', 100, 200, 'user-a');
SELECT public.record_stealth_scan_range('00000000-0000-0000-0000-0000000000a7', 202, 300, 'user-a');
SELECT public.t_assert_ranges('8 a one-block gap must NOT merge',
       '00000000-0000-0000-0000-0000000000a7', '[100,200] [202,300]');

-- Case 9. A single-height range, and then the two heights either side of it,
-- which must close it up into one. Degenerate ranges are legal (from = to)
-- and the arithmetic has to hold there too.
SELECT public.record_stealth_scan_range('00000000-0000-0000-0000-0000000000a8', 500, 500, 'user-a');
SELECT public.t_assert_ranges('9a single-height range is stored as itself',
       '00000000-0000-0000-0000-0000000000a8', '[500,500]');
SELECT public.record_stealth_scan_range('00000000-0000-0000-0000-0000000000a8', 501, 501, 'user-a');
SELECT public.record_stealth_scan_range('00000000-0000-0000-0000-0000000000a8', 499, 499, 'user-a');
SELECT public.t_assert_ranges('9b neighbouring single heights close it up',
       '00000000-0000-0000-0000-0000000000a8', '[499,501]');

-- Case 10. OWNERSHIP. The guard added for the cross-tenant write defect. A
-- guard that has only ever been observed permitting is not a guard anyone has
-- tested, so each of the three refusal paths is exercised and then the table
-- is checked to prove nothing was written on the way out.
SELECT public.t_assert_refused('10a a caller who does not own the connection is refused',
       '00000000-0000-0000-0000-0000000000a9'::uuid, 100, 200, 'user-a');

SELECT public.t_assert_refused('10b a connection with no owner is refused',
       '00000000-0000-0000-0000-0000000000a9'::uuid, 100, 200, NULL);

SELECT public.t_assert_refused('10c an unknown connection id is refused',
       '00000000-0000-0000-0000-0000000000ff'::uuid, 100, 200, 'user-a');

SELECT public.t_assert_ranges('10d nothing was written by any refused call',
       '00000000-0000-0000-0000-0000000000a9', '(none)');

-- Case 11. A second customer writing against their own connection must not
-- touch the first customer's ranges. Case 2 left connection a1 holding
-- [100,250]; a write by user-b against a1 must be refused and a1 must be
-- untouched.
INSERT INTO public.stealth_connections (id, app_user_id)
VALUES ('00000000-0000-0000-0000-0000000000b1', 'user-b');

SELECT public.t_assert_refused('11a user-b cannot write against user-a''s connection',
       '00000000-0000-0000-0000-0000000000a1'::uuid, 1, 999999, 'user-b');

SELECT public.t_assert_ranges('11b user-a''s ranges are untouched by the refused write',
       '00000000-0000-0000-0000-0000000000a1', '[100,250]');

SELECT public.record_stealth_scan_range('00000000-0000-0000-0000-0000000000b1', 700, 800, 'user-b');
SELECT public.t_assert_ranges('11c user-b writes to their own connection normally',
       '00000000-0000-0000-0000-0000000000b1', '[700,800]');

COMMIT;
