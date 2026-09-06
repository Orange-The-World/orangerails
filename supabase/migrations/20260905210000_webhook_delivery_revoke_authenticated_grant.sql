-- OR-T2393: webhook_delivery is service_role only by design (its one RLS
-- policy, "webhook_delivery service role only", covers only service_role,
-- FOR ALL). The authenticated grant was never narrowed to match, so it sits
-- as SELECT/INSERT/UPDATE/DELETE with zero policy coverage: deny-by-default
-- today only because no policy admits it, not because anything revoked it
-- on purpose. Same shape as the 30 tables fixed on OR-T1421 (PRs #1112, #1118).
--
-- Verified before writing this file (dev, fzwmnzmtqidumdqjdddz):
--   relacl: {postgres=arwdDxtm/postgres,authenticated=arwd/postgres,
--            service_role=arwdDxtm/postgres,or_agent_reader=r/postgres}
--   No column-level grants on this table (pg_attribute.attacl all null).
--   Every code path that touches this table uses a service_role client:
--   supabase/functions/or-sync, or-webhook-dispatch, or-quiltt-sync.
--   Nothing calls it as authenticated.
--
-- Fix is REVOKE, not add a policy: the policy already expresses the
-- intended design (service_role only), the grant just never matched it.

REVOKE ALL ON public.webhook_delivery FROM authenticated;

DO $assert$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a
    JOIN pg_roles r ON r.oid = a.grantee
   WHERE n.nspname = 'public'
     AND c.relname = 'webhook_delivery'
     AND r.rolname = 'authenticated';

  IF v_count > 0 THEN
    RAISE EXCEPTION 'OR-T2393 assert: authenticated still holds % grant(s) on public.webhook_delivery', v_count;
  END IF;
END $assert$;
