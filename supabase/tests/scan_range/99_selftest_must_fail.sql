-- HARNESS SELF-TEST. This file is SUPPOSED to fail (DL-1856).
--
-- It asserts something that is known to be false. The CI step that runs it
-- inverts the exit code: the job fails if psql exits ZERO here.
--
-- Why it exists. Every part of this suite could be wired up wrong in a way
-- that produces a green tick and tests nothing: ON_ERROR_STOP left unset so a
-- failing assertion only prints, the wrong file path so psql reads nothing,
-- the wrong database so the tables are empty, or a helper that raises NOTICE
-- where it meant to RAISE EXCEPTION. Every one of those looks exactly like a
-- passing run. This file is the one that proves the difference is visible.
--
-- If this file ever passes, do not adjust it. The suite is broken.

BEGIN;

INSERT INTO public.stealth_connections (id, app_user_id)
VALUES ('00000000-0000-0000-0000-0000000000fe', 'selftest-user');

SELECT public.record_stealth_scan_range('00000000-0000-0000-0000-0000000000fe', 100, 200, 'selftest-user');

-- The range set really is [100,200]. Asserting [1,2] must raise.
SELECT public.t_assert_ranges('SELFTEST this assertion is designed to FAIL',
       '00000000-0000-0000-0000-0000000000fe', '[1,2]');

-- Unreachable. If control ever gets here the assertion above did not raise,
-- and this makes that loud rather than letting the file end quietly.
DO $$
BEGIN
  RAISE EXCEPTION 'SELFTEST BROKEN: t_assert_ranges did not raise on a false expectation. Every assertion in this suite is therefore worthless.';
END $$;

ROLLBACK;
