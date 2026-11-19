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
