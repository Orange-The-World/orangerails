-- get_or_internal_worker_token(): read the internal worker token from Vault (DL-0426).
--
-- Why this file exists: the function has been live on dev since it was created
-- out of band and has never had a migration. Prod does not have it. Applying it
-- to prod from a chat message would have created production DDL with no source
-- of truth in git, so the definition is captured here first.
--
-- The body below is the exact pg_get_functiondef output from dev
-- (project fzwmnzmtqidumdqjdddz). The grant block reproduces the dev ACL
-- {postgres=X/postgres,service_role=X/postgres}: no PUBLIC, no anon, no
-- authenticated, so no client facing role can execute it.
--
-- Self custody note: this returns an internal service token used by the cron
-- path to authenticate to an edge function. It never returns a user key, a
-- seed, or any user plaintext.

CREATE OR REPLACE FUNCTION public.get_or_internal_worker_token()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  secret_val text;
BEGIN
  SELECT decrypted_secret INTO secret_val
  FROM vault.decrypted_secrets
  WHERE name = 'or_internal_worker_token'
  LIMIT 1;
  RETURN secret_val;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_or_internal_worker_token() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_or_internal_worker_token() FROM anon;
REVOKE ALL ON FUNCTION public.get_or_internal_worker_token() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_or_internal_worker_token() TO service_role;

COMMENT ON FUNCTION public.get_or_internal_worker_token() IS
  'Returns the or_internal_worker_token secret from Supabase Vault. SECURITY DEFINER with an empty search_path. EXECUTE is granted to service_role only: no PUBLIC, anon or authenticated access. Never returns a user key, seed or plaintext.';
