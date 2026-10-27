-- Fixture for OR-T1376's self-test.
--
-- The same dynamic shape as dynamic_drop_policy.sql, but with the
-- opt-out marker directly above the DROP POLICY line. This must NOT be
-- flagged, proving the escape hatch works and is visible in review.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'connections' LOOP
    -- lint-allow-dynamic-policy-drop: intentional full reset during a platform migration, reviewed 2026-09-02, OR-T1376
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.connections', r.policyname);
  END LOOP;
END $$;
