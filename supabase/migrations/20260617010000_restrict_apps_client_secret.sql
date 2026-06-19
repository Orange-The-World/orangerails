-- Restrict apps.client_secret to service_role only — close audit finding M3.
--
-- The migration that created public.apps (20260419120000_orangerails_hub_foundation
-- .sql) intended the client_secret column to be readable only by the service
-- role, with the comment "They cannot see client_secret values — they appear
-- in row data but RLS prevents reading them; see separate policies below."
-- No such policy was ever added. The actual RLS policy is:
--
--   CREATE POLICY "Anyone can read app public metadata"
--     ON public.apps FOR SELECT
--     TO authenticated, anon
--     USING (true);
--
-- USING (true) returns every column. Any authenticated or anonymous caller
-- could `SELECT client_secret FROM apps` and get the HMAC signing secret.
--
-- Fix: revoke column-level SELECT on client_secret from both anon and
-- authenticated. Row-level SELECT on the other columns (id, slug, name,
-- description, redirect_uri_pattern, created_at, updated_at) is unaffected —
-- those are intentional metadata for the OR Link widget's app-display step.
--
-- Service role still has full access (it's not subject to GRANT/REVOKE on the
-- table-owner side; it bypasses RLS too).
--
-- Status check 2026-06-17: client_secret is not referenced anywhere in code
-- (`grep -r client_secret supabase/functions/ src/` returns only the
-- generated types file). The column is reserved for the Phase 5 hardening
-- step but unused today. Once Phase 5 confirms whether the HMAC-signing
-- mechanism actually ships, either re-grant column SELECT to the specific
-- service that needs it, or drop the column with a separate migration.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'apps'
  ) THEN
    -- Idempotent: REVOKE on a privilege that's already gone is a no-op.
    REVOKE SELECT (client_secret) ON public.apps FROM anon;
    REVOKE SELECT (client_secret) ON public.apps FROM authenticated;
  END IF;
END $$;
