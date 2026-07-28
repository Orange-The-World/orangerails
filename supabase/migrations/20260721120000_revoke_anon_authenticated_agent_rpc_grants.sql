-- Scope the agent RPC surface to the service role that actually calls it.
--
-- Every function listed below is SECURITY DEFINER: it runs with owner rights
-- and does its own authorization internally. An EXECUTE grant to anon or to
-- authenticated is therefore a direct path to owner-rights execution for any
-- holder of the public anon key. The documented caller for all of them is the
-- service-role principal inside an edge function, so the anon and authenticated
-- grants buy nothing and only widen the surface.
--
-- increment_platform_rate_limit additionally carries a PUBLIC grant, which is
-- why PUBLIC is revoked as well as the two named roles.
--
-- or_create_platform is included to converge dev with prod. Prod already grants
-- only postgres and service_role; dev still grants authenticated. After this
-- migration the two projects hold the same ACL.
--
-- postgres and service_role grants are untouched, so no documented caller
-- loses access.
--
-- Idempotent: a REVOKE of a privilege that is already absent is a no-op, and
-- every entry is guarded with to_regprocedure so a project that does not have
-- one of these functions is skipped rather than failing the whole run.
--
-- Reversible: one line per function, run as postgres.
--   GRANT EXECUTE ON FUNCTION public.cleanup_expired_agent_invitation_tokens() TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.complete_agent_invitation(uuid,uuid,text,text) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.get_agent_pubkey_for_refresh(uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.increment_platform_rate_limit(text,text,timestamptz) TO anon, authenticated, PUBLIC;
--   GRANT EXECUTE ON FUNCTION public.log_agent_token_refresh(uuid,uuid,inet,text) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.mint_agent_invitation(text,public.agent_kind,public.agent_role,text,inet,text) TO anon;
--   GRANT EXECUTE ON FUNCTION public.or_create_platform(text,text,text,text,text,text,integer) TO authenticated;
--   GRANT EXECUTE ON FUNCTION public.peek_agent_invitation(text) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.revoke_agent_invitation_token(uuid) TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.revoke_agent_member(uuid,text) TO anon;
--   GRANT EXECUTE ON FUNCTION public.touch_agent_activity(uuid) TO anon, authenticated;

BEGIN;

DO $$
DECLARE
  v_sig  text;
  v_sigs text[] := ARRAY[
    'public.cleanup_expired_agent_invitation_tokens()',
    'public.complete_agent_invitation(uuid,uuid,text,text)',
    'public.get_agent_pubkey_for_refresh(uuid)',
    'public.increment_platform_rate_limit(text,text,timestamptz)',
    'public.log_agent_token_refresh(uuid,uuid,inet,text)',
    'public.mint_agent_invitation(text,public.agent_kind,public.agent_role,text,inet,text)',
    'public.or_create_platform(text,text,text,text,text,text,integer)',
    'public.peek_agent_invitation(text)',
    'public.revoke_agent_invitation_token(uuid)',
    'public.revoke_agent_member(uuid,text)',
    'public.touch_agent_activity(uuid)'
  ];
BEGIN
  FOREACH v_sig IN ARRAY v_sigs LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE NOTICE 'skipped, function not present on this project: %', v_sig;
    ELSE
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated, PUBLIC',
        v_sig
      );
    END IF;
  END LOOP;
END
$$;

COMMIT;
