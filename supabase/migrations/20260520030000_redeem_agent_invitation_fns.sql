-- ============================================================
-- Agent invitation redemption — peek + complete functions
-- ============================================================
-- See: docs/OrangeRails-Agent-Members.md
-- Session: 2026-05-19-ANVIL
--
-- Called by the or-agent-invite-redeem edge function. The two-phase split
-- exists because the edge function has to create the shadow auth.users
-- row BETWEEN the validation and the agent_members update — and creating
-- a Supabase auth user is not a SQL operation (it goes through GoTrue
-- admin API).
--
-- Phase 1: peek_agent_invitation(token_hash)
--   Read-only. Returns the invitation + agent_member ids if the token
--   is pending and not expired. Returns no rows if not.
--
-- Phase 2: complete_agent_invitation(invitation_id, shadow_user_id,
--          identity_pubkey, kem_pubkey)
--   Atomic. Updates agent_members (sets shadow_user_id + pubkeys +
--   activated_at) and agent_invitation_tokens (sets redeemed_at).
--   Both happen in one transaction. Returns the agent_member row.

-- ============================================================
-- 1. peek_agent_invitation(token_hash) — read-only validation
-- ============================================================
CREATE OR REPLACE FUNCTION public.peek_agent_invitation(p_token_hash TEXT)
RETURNS TABLE(
  invitation_id    UUID,
  agent_member_id  UUID,
  owner_user_id    UUID,
  expires_at       TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Validate input format
  IF p_token_hash IS NULL OR length(p_token_hash) <> 64 OR p_token_hash !~ '^[a-f0-9]+$' THEN
    -- Don't reveal whether the hash is well-formed vs not present.
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    t.id           AS invitation_id,
    t.agent_member_id,
    t.owner_user_id,
    t.expires_at
  FROM public.agent_invitation_tokens t
  WHERE t.token_hash = p_token_hash
    AND t.redeemed_at IS NULL
    AND t.revoked_at IS NULL
    AND t.expires_at > now()
  LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.peek_agent_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.peek_agent_invitation(TEXT) TO service_role;

COMMENT ON FUNCTION public.peek_agent_invitation IS
  'Read-only validation of an invitation token by hash. service_role only (called from edge function). Returns no rows if expired, redeemed, revoked, or not found.';

-- ============================================================
-- 2. complete_agent_invitation(...) — atomic redemption
-- ============================================================
CREATE OR REPLACE FUNCTION public.complete_agent_invitation(
  p_invitation_id    UUID,
  p_shadow_user_id   UUID,
  p_identity_pubkey  TEXT,
  p_kem_pubkey       TEXT
)
RETURNS TABLE(
  agent_member_id  UUID,
  owner_user_id    UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent_member_id  UUID;
  v_owner_user_id    UUID;
  v_redemption_done  BOOLEAN := false;
BEGIN
  -- Validate pubkey format (base64 with reasonable length).
  IF p_identity_pubkey IS NULL OR length(p_identity_pubkey) < 40 OR length(p_identity_pubkey) > 1024 THEN
    RAISE EXCEPTION 'identity_pubkey missing or invalid length';
  END IF;
  IF p_kem_pubkey IS NULL OR length(p_kem_pubkey) < 40 OR length(p_kem_pubkey) > 4096 THEN
    RAISE EXCEPTION 'kem_pubkey missing or invalid length';
  END IF;
  IF p_identity_pubkey !~ '^[A-Za-z0-9+/=_-]+$' THEN
    RAISE EXCEPTION 'identity_pubkey is not valid base64';
  END IF;
  IF p_kem_pubkey !~ '^[A-Za-z0-9+/=_-]+$' THEN
    RAISE EXCEPTION 'kem_pubkey is not valid base64';
  END IF;
  IF p_shadow_user_id IS NULL THEN
    RAISE EXCEPTION 'shadow_user_id is required';
  END IF;

  -- Lock the invitation row to prevent double-redeem races.
  SELECT t.agent_member_id, t.owner_user_id
  INTO v_agent_member_id, v_owner_user_id
  FROM public.agent_invitation_tokens t
  WHERE t.id = p_invitation_id
    AND t.redeemed_at IS NULL
    AND t.revoked_at IS NULL
    AND t.expires_at > now()
  FOR UPDATE;

  IF v_agent_member_id IS NULL THEN
    RAISE EXCEPTION 'Invitation not found, expired, redeemed, or revoked';
  END IF;

  -- Update the agent_members row with the shadow user + pubkeys + activated_at
  UPDATE public.agent_members
  SET
    shadow_user_id   = p_shadow_user_id,
    identity_pubkey  = p_identity_pubkey,
    kem_pubkey       = p_kem_pubkey,
    activated_at     = now(),
    last_activity_at = now()
  WHERE id = v_agent_member_id
    AND activated_at IS NULL;  -- guard against double activation

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent member already activated or missing';
  END IF;

  -- Mark the invitation as redeemed
  UPDATE public.agent_invitation_tokens
  SET redeemed_at = now()
  WHERE id = p_invitation_id;

  v_redemption_done := true;

  RETURN QUERY SELECT v_agent_member_id, v_owner_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_agent_invitation(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_agent_invitation(UUID, UUID, TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION public.complete_agent_invitation IS
  'Atomically marks an invitation redeemed + activates the agent_members row with shadow_user_id and pubkeys. service_role only.';
