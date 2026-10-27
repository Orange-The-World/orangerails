DO $$
BEGIN
  -- lint-allow-dynamic-policy-drop: reviewed compatibility cleanup for names created outside this repository
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.example', 'legacy_' || suffix);
END $$;
