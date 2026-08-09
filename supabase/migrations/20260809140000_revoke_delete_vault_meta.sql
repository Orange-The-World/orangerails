-- DL-0694 Vault meta rows must never be deletable through the application.
--
-- Problem: user_vault_meta and customer_vault_meta hold encrypted vault
-- metadata. RLS is enabled with no DELETE policy, so the authenticated role is
-- already denied. But service_role bypasses RLS, and it held a DELETE grant, so
-- a server-side path could delete vault metadata rows. Table grants are enforced
-- even when RLS is bypassed, so an RLS FOR DELETE USING(false) policy would not
-- close this; the REVOKE does.
--
-- Fix: revoke DELETE from anon, authenticated and service_role on both tables.
-- The owner (postgres) keeps implicit rights and the application never connects
-- as owner, so no legitimate path is affected.
--
-- Idempotent: REVOKE of a privilege not held emits a notice and changes nothing,
-- so a re-run is a no-op.
-- Reversible: yes. Down path:
--   GRANT DELETE ON public.user_vault_meta TO anon, authenticated, service_role;
--   GRANT DELETE ON public.customer_vault_meta TO anon, authenticated, service_role;

REVOKE DELETE ON public.user_vault_meta FROM anon, authenticated, service_role;
REVOKE DELETE ON public.customer_vault_meta FROM anon, authenticated, service_role;
