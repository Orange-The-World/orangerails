-- Fixture for OR-T1376's self-test.
--
-- Verbatim copy of the DO block from
-- supabase/migrations/20260421200000_platforms_subaccounts.sql, section 6,
-- that looped over pg_policies and silently destroyed a co-admin policy it
-- did not know about (OR-T1324). This file must make
-- migration_policy_drop_guard.py exit non-zero on both DROP POLICY lines.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'connections' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.connections', r.policyname);
  END LOOP;

  FOR r IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'encrypted_transactions' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.encrypted_transactions', r.policyname);
  END LOOP;
END $$;
