-- Scope internal views to service_role, and make views over RLS protected
-- tables run with the caller's rights.
--
-- platform_rate_limits_stale is a single table view over platform_rate_limits
-- (RLS on, zero policies). Owner rights execution plus anon and authenticated
-- grants made the view an updatable path around that RLS. Revoking the grants
-- and setting security_invoker closes it. The base table's own anon and
-- authenticated grants are inert today (RLS with no policies) but would go live
-- the moment a permissive policy is added, so they are removed as well.
--
-- Only postgres and service_role keep access. Both carry BYPASSRLS, so no
-- caller loses rows when security_invoker is turned on.
--
-- Reversible: re-GRANT the privileges, and ALTER VIEW ... SET (security_invoker
-- = false). Idempotent: every statement is safe to re-run.

BEGIN;

REVOKE ALL ON TABLE public.platform_rate_limits_stale FROM anon, authenticated;
REVOKE ALL ON TABLE public.platform_rate_limits       FROM anon, authenticated;
REVOKE ALL ON TABLE public.v_platform_quiltt_config   FROM anon, authenticated;

ALTER VIEW public.platform_rate_limits_stale SET (security_invoker = true);
ALTER VIEW public.v_platform_quiltt_config   SET (security_invoker = true);

-- Materialized views ignore RLS entirely, so the grant is the only control.
-- This one exists on the prod project only, hence the guard.
DO $$
BEGIN
  IF to_regclass('public.orbi_pair_inventory_strength') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public.orbi_pair_inventory_strength FROM anon, authenticated';
  END IF;
END
$$;

COMMIT;
