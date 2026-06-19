-- ============================================================
-- mint_agent_invitation() — atomic create-agent-member + create-invitation-token
-- ============================================================
-- See: docs/OrangeRails-Agent-Members.md
-- Session: 2026-05-19-ANVIL
--
-- Called by the or-agent-invite-mint edge function. The edge function:
--   1. Authenticates the caller as a logged-in user (the owner)
--   2. Generates a 256-bit random token on the server side
--   3. Computes SHA-256 hash of the token
--   4. Calls this function with the hash + agent metadata
--   5. Returns the raw token to the owner (shown once, never stored)
--
-- Rate limit: max 10 pending (un-redeemed, un-revoked, un-expired)
-- invitations per owner at a time. Prevents token spam.

CREATE OR REPLACE FUNCTION public.mint_agent_invitation(
  p_agent_name  TEXT,
  p_agent_kind  public.agent_kind,
  p_role        public.agent_role,
  p_token_hash  TEXT,
  p_created_from_ip   INET DEFAULT NULL,
  p_created_from_ua   TEXT DEFAULT NULL
)
RETURNS TABLE(
  agent_member_id  UUID,
  invitation_id    UUID,
  expires_at       TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner            UUID := auth.uid();
  v_pending_count    INT;
  v_agent_member_id  UUID;
  v_invitation_id    UUID;
  v_expires_at       TIMESTAMPTZ := now() + interval '7 days';
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: no auth context';
  END IF;

  -- Validate agent_name
  IF p_agent_name IS NULL OR length(trim(p_agent_name)) = 0 THEN
    RAISE EXCEPTION 'agent_name is required';
  END IF;
  IF length(p_agent_name) > 100 THEN
    RAISE EXCEPTION 'agent_name too long (max 100 chars)';
  END IF;

  -- Validate token_hash format (64-char hex = SHA-256)
  IF p_token_hash IS NULL OR length(p_token_hash) <> 64 OR p_token_hash !~ '^[a-f0-9]+$' THEN
    RAISE EXCEPTION 'token_hash must be 64-char lowercase hex (SHA-256)';
  END IF;

  -- Rate limit: max 10 pending invitations per owner
  SELECT count(*)::INT INTO v_pending_count
  FROM public.agent_invitation_tokens t
  WHERE t.owner_user_id = v_owner
    AND t.redeemed_at IS NULL
    AND t.revoked_at IS NULL
    AND t.expires_at > now();

  IF v_pending_count >= 10 THEN
    RAISE EXCEPTION 'Too many pending invitations (max 10). Revoke unused invitations first.';
  END IF;

  -- Insert the agent_members row (pubkeys NULL, activated_at NULL — set on redeem)
  INSERT INTO public.agent_members (
    owner_user_id,
    agent_name,
    agent_kind,
    role
  ) VALUES (
    v_owner,
    trim(p_agent_name),
    p_agent_kind,
    p_role
  )
  RETURNING id INTO v_agent_member_id;

  -- Insert the invitation token row
  INSERT INTO public.agent_invitation_tokens (
    agent_member_id,
    owner_user_id,
    token_hash,
    expires_at,
    created_from_ip,
    created_from_ua
  ) VALUES (
    v_agent_member_id,
    v_owner,
    p_token_hash,
    v_expires_at,
    p_created_from_ip,
    p_created_from_ua
  )
  RETURNING id INTO v_invitation_id;

  RETURN QUERY SELECT v_agent_member_id, v_invitation_id, v_expires_at;
END;
$$;

REVOKE ALL ON FUNCTION public.mint_agent_invitation(TEXT, public.agent_kind, public.agent_role, TEXT, INET, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mint_agent_invitation(TEXT, public.agent_kind, public.agent_role, TEXT, INET, TEXT) TO authenticated;

COMMENT ON FUNCTION public.mint_agent_invitation IS
  'Atomically creates an agent_members row + agent_invitation_tokens row. Called by or-agent-invite-mint edge function. Owner-only (uses auth.uid()).';
