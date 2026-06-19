-- ============================================================
-- get_agent_pubkey_for_refresh — read agent's Ed25519 pubkey for nonce verification
-- ============================================================
-- See: docs/OrangeRails-Agent-Members.md
-- Session: 2026-05-21-BIRCH
--
-- Called by the or-agent-token-refresh edge function. Returns the agent's
-- identity_pubkey + shadow_user_id IF the agent is active (activated_at NOT
-- NULL, revoked_at IS NULL). Otherwise returns no rows so the refresh fails.
--
-- service_role only; agent never reads this directly.

CREATE OR REPLACE FUNCTION public.get_agent_pubkey_for_refresh(p_agent_member_id UUID)
RETURNS TABLE(
  shadow_user_id   UUID,
  identity_pubkey  TEXT,
  agent_role       public.agent_role,
  owner_user_id    UUID
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    am.shadow_user_id,
    am.identity_pubkey,
    am.role,
    am.owner_user_id
  FROM public.agent_members am
  WHERE am.id = p_agent_member_id
    AND am.activated_at IS NOT NULL
    AND am.revoked_at IS NULL
    AND am.shadow_user_id IS NOT NULL
    AND am.identity_pubkey IS NOT NULL
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_agent_pubkey_for_refresh(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_agent_pubkey_for_refresh(UUID) TO service_role;

COMMENT ON FUNCTION public.get_agent_pubkey_for_refresh IS
  'Returns the active agent member''s shadow user + Ed25519 identity pubkey + role + owner. Returns no rows if the agent is not activated or has been revoked. service_role only.';

-- ============================================================
-- touch_agent_activity — bump last_activity_at after successful refresh
-- ============================================================
-- Separate function to keep concerns focused. Always succeeds (idempotent).

CREATE OR REPLACE FUNCTION public.touch_agent_activity(p_agent_member_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.agent_members
  SET last_activity_at = now()
  WHERE id = p_agent_member_id;
$$;

REVOKE ALL ON FUNCTION public.touch_agent_activity(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.touch_agent_activity(UUID) TO service_role;

COMMENT ON FUNCTION public.touch_agent_activity IS
  'Bumps agent_members.last_activity_at after a successful API call. Used by the refresh endpoint.';
