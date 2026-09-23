-- Harness self-test for the user_vault_meta RLS suite (OR-T0690).
-- This file is SUPPOSED TO FAIL. The CI step wrapping it treats a clean
-- exit as the error (see the "Self-test the harness" step in ci.yml).
--
-- RUNS BEFORE 10_rls_assertions.sql in the job (see ci.yml's step order),
-- so it cannot rely on that file's rows existing yet. It seeds its own
-- dedicated selftest-only rows below, using ids (...fe, ...ff) distinct
-- from 10_rls_assertions.sql's (...a1 through ...a3), and wraps them in
-- BEGIN/ROLLBACK so nothing here is still around when the later step does
-- its own INSERTs. Same shape as
-- supabase/tests/scan_range/99_selftest_must_fail.sql.
--
-- CORRECTED 2026-09-23: the previous version of this file called
-- t_assert_update_count directly against ...a1/...a2 with no INSERT of its
-- own, relying on 10_rls_assertions.sql having already seeded them. Given
-- the step order above, that data did not exist yet when this file ran, so
-- the "must fail" assertion was failing because the target row did not
-- exist, not because RLS refused anything. It would have reported the
-- identical outcome whether or not row level security worked at all, so
-- it proved nothing about the harness. Fixed by seeding this file's own
-- fixture, the same way scan_range's self-test always has.
--
-- TWO known-false cases below, one per assertion helper this suite
-- defines. Each is wrapped in its own DO block with internal exception
-- handling so a CORRECTLY-raised "expected" failure does not stop the
-- script here: psql runs with ON_ERROR_STOP=1, which would otherwise abort
-- at the first case and leave the second never executed. Only an
-- INCORRECT outcome, a helper failing to notice a known-false input,
-- propagates out of its DO block, and it names which helper by name.

BEGIN;

INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000000fe'),
  ('00000000-0000-0000-0000-0000000000ff');

INSERT INTO public.user_vault_meta (user_id, vault_salt, vault_verifier_ciphertext) VALUES
  ('00000000-0000-0000-0000-0000000000fe', 'selftest-salt-fe', 'selftest-verifier-fe'),
  ('00000000-0000-0000-0000-0000000000ff', 'selftest-salt-ff', 'selftest-verifier-ff');

-- CASE 1/2: t_assert_update_count. The real answer (10_rls_assertions.sql)
-- is that user fe updating user ff's row affects 0 rows. Demanding 1 is
-- known false.
DO $$
DECLARE
  v_raised boolean := false;
BEGIN
  BEGIN
    PERFORM public.t_assert_update_count(
      'SELFTEST (must fail): user fe updating user ff row must NOT report 1',
      '00000000-0000-0000-0000-0000000000fe'::uuid,
      '00000000-0000-0000-0000-0000000000ff'::uuid,
      1
    );
  EXCEPTION WHEN OTHERS THEN
    v_raised := true;
    RAISE NOTICE 'SELFTEST 1/2 correctly raised: %', SQLERRM;
  END;

  IF NOT v_raised THEN
    RAISE EXCEPTION 'SELFTEST BROKEN: t_assert_update_count did not fail on a known-false expectation (user fe updating user ff row must NOT report 1). Every update-count assertion in this suite is worthless.';
  END IF;
END $$;

-- CASE 2/2: t_assert_reassign_outcome, the assertion the Auditor's review
-- of PR #1559 required (2026-09-23): a signed-in user reassigning their
-- OWN row's user_id to someone else's id must be refused. The real answer
-- is refused=true; demanding refused=false (must NOT be reported as
-- refused) is known false.
DO $$
DECLARE
  v_raised boolean := false;
BEGIN
  BEGIN
    PERFORM public.t_assert_reassign_outcome(
      'SELFTEST (must fail): user fe reassigning own row to user ff must NOT be reported as refused',
      '00000000-0000-0000-0000-0000000000fe'::uuid,
      '00000000-0000-0000-0000-0000000000ff'::uuid,
      false
    );
  EXCEPTION WHEN OTHERS THEN
    v_raised := true;
    RAISE NOTICE 'SELFTEST 2/2 correctly raised: %', SQLERRM;
  END;

  IF NOT v_raised THEN
    RAISE EXCEPTION 'SELFTEST BROKEN: t_assert_reassign_outcome did not fail on a known-false expectation (user fe reassigning own row to user ff must NOT be reported as refused). Every reassignment assertion in this suite is worthless.';
  END IF;
END $$;

ROLLBACK;

-- Both cases above were individually verified to raise on a known-false
-- input, or this file would already have stopped above (ON_ERROR_STOP=1)
-- with a SELFTEST BROKEN message naming which helper failed to catch it.
-- This file's whole point is proving the harness CAN go red, so it must
-- still end in an error: the CI step inverts the exit code and requires
-- this file's own psql invocation to exit nonzero.
DO $$
BEGIN
  RAISE EXCEPTION 'SELFTEST OK: both known-false assertions above correctly raised (see the NOTICEs). This file always ends in an error by design so psql exits nonzero; see the header comment and ci.yml''s "Self-test the harness" step.';
END $$;
