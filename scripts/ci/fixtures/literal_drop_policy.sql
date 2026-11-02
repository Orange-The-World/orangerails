-- Fixture for OR-T1376's self-test.
--
-- A literal DROP POLICY IF EXISTS, naming the policy directly. This is the
-- shape every real migration should use, and must never be flagged.

DROP POLICY IF EXISTS "Direct users can read connections via their subaccount" ON public.connections;
CREATE POLICY "Direct users can read connections via their subaccount"
  ON public.connections FOR SELECT
  TO authenticated
  USING (true);
