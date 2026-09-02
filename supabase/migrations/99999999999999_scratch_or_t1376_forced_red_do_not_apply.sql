-- SCRATCH FIXTURE, DO NOT APPLY. Proves OR-T1376's CI check goes RED on the exact shape
-- that ate a co-admin policy in 20260421200000_platforms_subaccounts.sql. This PR is closed
-- without merging once the run is recorded; see OR-T1376 for the run URL.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'scratch_or_t1376_fixture' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.scratch_or_t1376_fixture', r.policyname);
  END LOOP;
END $$;
