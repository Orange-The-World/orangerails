-- DL-0548: revoke anon and authenticated EXECUTE on agent invitation and lifecycle functions
--
-- WHY
-- On prod, nine SECURITY DEFINER functions in the public schema carry EXECUTE for the
-- anon and/or authenticated role. That grant was never in the migration history: every
-- CREATE in supabase/migrations does REVOKE ALL ON FUNCTION ... FROM PUBLIC and then
-- GRANT EXECUTE ... TO service_role only, never to anon or authenticated. The extra grant
-- is out-of-band drift applied outside the migration history. Dev already sits at the
-- intended state (service_role plus postgres only) and its test suite is green, so the
-- application does not depend on the anon or authenticated path. These functions are
-- SECURITY DEFINER, so an anon EXECUTE lets an unauthenticated caller invoke privileged
-- logic. This migration realigns prod back to the migration history.
--
-- SCOPE
-- All nine affected functions, full signatures. This is wider than the two originally
-- named on the ticket: verified against prod pg_proc on 2026-08-02.
--
-- REVERSIBLE
-- Yes. To undo, GRANT EXECUTE back to the named roles (see the commented block at the end).
-- Reversal is intentionally undesirable because it re-introduces the exposure. REVOKE of a
-- grant that is already absent is a no-op, so this migration is idempotent and safe to
-- re-run. On dev it is a no-op because the grants are already absent there.

REVOKE EXECUTE ON FUNCTION public.cleanup_expired_agent_invitation_tokens() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_agent_invitation(uuid, uuid, text, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_agent_pubkey_for_refresh(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.log_agent_token_refresh(uuid, uuid, inet, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mint_agent_invitation(text, public.agent_kind, public.agent_role, text, inet, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.peek_agent_invitation(text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.revoke_agent_invitation_token(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.revoke_agent_member(uuid, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.touch_agent_activity(uuid) FROM anon, authenticated;

-- REVERSAL (do not uncomment unless you intend to restore the exposure):
-- GRANT EXECUTE ON FUNCTION public.cleanup_expired_agent_invitation_tokens() TO anon, authenticated;
-- GRANT EXECUTE ON FUNCTION public.complete_agent_invitation(uuid, uuid, text, text) TO anon, authenticated;
-- GRANT EXECUTE ON FUNCTION public.get_agent_pubkey_for_refresh(uuid) TO anon, authenticated;
-- GRANT EXECUTE ON FUNCTION public.log_agent_token_refresh(uuid, uuid, inet, text) TO anon, authenticated;
-- GRANT EXECUTE ON FUNCTION public.mint_agent_invitation(text, public.agent_kind, public.agent_role, text, inet, text) TO anon, authenticated;
-- GRANT EXECUTE ON FUNCTION public.peek_agent_invitation(text) TO anon, authenticated;
-- GRANT EXECUTE ON FUNCTION public.revoke_agent_invitation_token(uuid) TO anon, authenticated;
-- GRANT EXECUTE ON FUNCTION public.revoke_agent_member(uuid, text) TO anon, authenticated;
-- GRANT EXECUTE ON FUNCTION public.touch_agent_activity(uuid) TO anon, authenticated;
