-- ============================================================
-- revoke_agent_member — owner revokes one of their AI agent members
-- ============================================================
-- See: docs/OrangeRails-Agent-Members.md
-- Session: 2026-05-21-BIRCH
--
-- Atomic revocation:
--   1. Marks agent_members.revoked_at = now()
--   2. Deletes wrapped_data_keys rows keyed to the agent's shadow_user_id
--      (so even if the agent kept a copy of its identity_privkey, it
--      cannot unwrap any future org data key the owner re-shares)
--   3. Bans the shadow auth.users (NOT shipped in this function — handled
--      by the edge function calling auth.admin.deleteUser as a separate step)
--   4. Writes an audit_entries row attributing the revocation
--
-- Browser-side data-key rotation is a separate v1.1 task. Without rotation,
-- the agent's pre-existing wrapped envelopes are deleted (step 2) but the
-- current org data key value remains in memory across remaining members.
-- The agent cannot decrypt NEWLY-WRITTEN ciphertext because it has no row
-- in wrapped_data_keys. It can still decrypt cached data it already had.
-- This matches the "revoked agent cannot read new data" promise from doc 02.

CREATE OR REPLACE FUNCTION public.revoke_agent_member(
  p_agent_member_id UUID,
  p_reason TEXT DEFAULT NULL
)
RETURNS TABLE(
  agent_member_id   UUID,
  shadow_user_id    UUID,
  wrapped_keys_deleted INT,
  audit_entry_id    UUID,
  was_already_revoked BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller          UUID := auth.uid();
  v_shadow_user_id  UUID;
  v_owner_user_id   UUID;
  v_agent_name      TEXT;
  v_was_revoked     BOOLEAN := FALSE;
  v_keys_deleted    INT := 0;
  v_audit_id        UUID;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: no auth context';
  END IF;

  -- Lock the agent row to serialize concurrent revoke attempts.
  SELECT shadow_user_id, owner_user_id, agent_name, (revoked_at IS NOT NULL)
  INTO v_shadow_user_id, v_owner_user_id, v_agent_name, v_was_revoked
  FROM public.agent_members
  WHERE id = p_agent_member_id
  FOR UPDATE;

  IF v_owner_user_id IS NULL THEN
    RAISE EXCEPTION 'Agent member not found';
  END IF;

  IF v_owner_user_id <> v_caller THEN
    RAISE EXCEPTION 'Forbidden: caller is not the owner of this agent';
  END IF;

  IF v_was_revoked THEN
    -- Idempotent: return existing state without re-deleting
    RETURN QUERY SELECT p_agent_member_id, v_shadow_user_id, 0, NULL::UUID, TRUE;
    RETURN;
  END IF;

  -- 1. Mark revoked
  UPDATE public.agent_members
  SET revoked_at = now()
  WHERE id = p_agent_member_id;

  -- 2. Delete the agent's wrapped_data_keys envelope rows
  IF v_shadow_user_id IS NOT NULL THEN
    WITH del AS (
      DELETE FROM public.wrapped_data_keys
      WHERE recipient_user_id = v_shadow_user_id
      RETURNING 1
    )
    SELECT count(*)::INT INTO v_keys_deleted FROM del;
  END IF;

  -- 3. Append an audit entry attributing the revoke
  SELECT a.entry_id
  INTO v_audit_id
  FROM public.append_audit_entry(
    p_action := 'agents.revoke',
    p_actor_user_id := v_caller,
    p_actor_member_id := NULL,
    p_resource_type := 'agent_member',
    p_resource_id := p_agent_member_id::TEXT,
    p_reason := p_reason,
    p_result := 'ok'
  ) a;

  RETURN QUERY SELECT p_agent_member_id, v_shadow_user_id, v_keys_deleted, v_audit_id, FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_agent_member(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_agent_member(UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION public.revoke_agent_member IS
  'Owner-only atomic revocation: sets revoked_at + deletes wrapped_data_keys for the agent + writes an audit entry. Idempotent (returns was_already_revoked=true on second call).';
