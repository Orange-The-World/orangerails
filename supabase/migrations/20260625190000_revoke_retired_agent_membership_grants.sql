-- Revoke EXECUTE grants on the agent-membership SECURITY DEFINER functions
-- whose only documented client was retired in PR #48 + this PR.
--
-- The functions are intentionally kept in the schema (rollback is trivial
-- if the feature returns from internal validation), but with no caller in
-- the public surface they should not be invocable by any authenticated
-- JWT holder via PostgREST /rpc.
--
-- Safe to apply: REVOKE on a non-existent grant is a no-op, and the
-- functions all exist as of migration 20260521010000.

DO $$
BEGIN
  -- mint_agent_invitation: previously called by InviteAgentDialog
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'mint_agent_invitation'
  ) THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.mint_agent_invitation FROM authenticated';
  END IF;

  -- revoke_agent_member: previously called by AgentMembersSection
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'revoke_agent_member'
  ) THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.revoke_agent_member FROM authenticated';
  END IF;

  -- rotate_data_key: agent-membership-adjacent helper
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'rotate_data_key'
  ) THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.rotate_data_key FROM authenticated';
  END IF;
END
$$;

-- The redeem_agent_invitation_token and agent_refresh_token functions were
-- called by the now-deleted edge functions using the service_role key, not
-- by authenticated end users. They never had EXECUTE granted to authenticated
-- in the first place, so no REVOKE is needed here.

COMMENT ON SCHEMA public IS
  'Database tables for the agent-membership feature (agent_members, agent_invitation_tokens, audit_entries, consumed_refresh_nonces) and their helper functions remain in place after the feature was retired from the public repo on 2026-06-25. They are intentionally preserved to keep rollback trivial if the feature returns from internal validation. EXECUTE grants on the SECURITY DEFINER functions have been REVOKEd so they cannot be called by an authenticated JWT holder via PostgREST /rpc.';
