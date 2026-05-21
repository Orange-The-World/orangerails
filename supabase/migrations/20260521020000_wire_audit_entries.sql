-- ============================================================
-- Wire audit_entries into the existing agent edge functions
-- ============================================================
-- Session: 2026-05-21-BIRCH
--
-- Extends the existing mint_agent_invitation, complete_agent_invitation,
-- and adds a log_agent_token_refresh helper so every agent lifecycle
-- event ends up in audit_entries with the right attribution.
--
-- All updates are CREATE OR REPLACE — idempotent. No schema changes.
-- The new audit row is appended INSIDE the same transaction as the
-- action it records, so partial writes are impossible.

-- ============================================================
-- 1. mint_agent_invitation — now writes 'agents.invite_minted'
-- ============================================================
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

  IF p_agent_name IS NULL OR length(trim(p_agent_name)) = 0 THEN
    RAISE EXCEPTION 'agent_name is required';
  END IF;
  IF length(p_agent_name) > 100 THEN
    RAISE EXCEPTION 'agent_name too long (max 100 chars)';
  END IF;
  IF p_token_hash IS NULL OR length(p_token_hash) <> 64 OR p_token_hash !~ '^[a-f0-9]+$' THEN
    RAISE EXCEPTION 'token_hash must be 64-char lowercase hex (SHA-256)';
  END IF;

  SELECT count(*)::INT INTO v_pending_count
  FROM public.agent_invitation_tokens t
  WHERE t.owner_user_id = v_owner
    AND t.redeemed_at IS NULL
    AND t.revoked_at IS NULL
    AND t.expires_at > now();
  IF v_pending_count >= 10 THEN
    RAISE EXCEPTION 'Too many pending invitations (max 10). Revoke unused invitations first.';
  END IF;

  INSERT INTO public.agent_members (owner_user_id, agent_name, agent_kind, role)
  VALUES (v_owner, trim(p_agent_name), p_agent_kind, p_role)
  RETURNING id INTO v_agent_member_id;

  INSERT INTO public.agent_invitation_tokens (
    agent_member_id, owner_user_id, token_hash, expires_at,
    created_from_ip, created_from_ua
  ) VALUES (
    v_agent_member_id, v_owner, p_token_hash, v_expires_at,
    p_created_from_ip, p_created_from_ua
  )
  RETURNING id INTO v_invitation_id;

  -- Audit
  PERFORM public.append_audit_entry(
    p_action          => 'agents.invite_minted',
    p_actor_user_id   => v_owner,
    p_actor_member_id => NULL,
    p_resource_type   => 'agent_member',
    p_resource_id     => v_agent_member_id::TEXT,
    p_client_ip       => p_created_from_ip,
    p_client_user_agent => p_created_from_ua,
    p_result          => 'ok'
  );

  RETURN QUERY SELECT v_agent_member_id, v_invitation_id, v_expires_at;
END;
$$;

REVOKE ALL ON FUNCTION public.mint_agent_invitation(TEXT, public.agent_kind, public.agent_role, TEXT, INET, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mint_agent_invitation(TEXT, public.agent_kind, public.agent_role, TEXT, INET, TEXT) TO authenticated;

-- ============================================================
-- 2. complete_agent_invitation — now writes 'agents.invite_redeemed'
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
BEGIN
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

  UPDATE public.agent_members
  SET shadow_user_id  = p_shadow_user_id,
      identity_pubkey = p_identity_pubkey,
      kem_pubkey      = p_kem_pubkey,
      activated_at    = now(),
      last_activity_at = now()
  WHERE id = v_agent_member_id AND activated_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent member already activated or missing';
  END IF;

  UPDATE public.agent_invitation_tokens
  SET redeemed_at = now()
  WHERE id = p_invitation_id;

  -- Audit attributed to the NEW agent itself (it has just become a member)
  PERFORM public.append_audit_entry(
    p_action          => 'agents.invite_redeemed',
    p_actor_user_id   => p_shadow_user_id,
    p_actor_member_id => v_agent_member_id,
    p_resource_type   => 'agent_member',
    p_resource_id     => v_agent_member_id::TEXT,
    p_result          => 'ok'
  );

  RETURN QUERY SELECT v_agent_member_id, v_owner_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_agent_invitation(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_agent_invitation(UUID, UUID, TEXT, TEXT) TO service_role;

-- ============================================================
-- 3. log_agent_token_refresh — helper for or-agent-token-refresh edge fn
-- ============================================================
CREATE OR REPLACE FUNCTION public.log_agent_token_refresh(
  p_agent_member_id UUID,
  p_shadow_user_id  UUID,
  p_client_ip       INET DEFAULT NULL,
  p_client_user_agent TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.append_audit_entry(
    p_action          => 'agents.token_refreshed',
    p_actor_user_id   => p_shadow_user_id,
    p_actor_member_id => p_agent_member_id,
    p_resource_type   => 'agent_member',
    p_resource_id     => p_agent_member_id::TEXT,
    p_client_ip       => p_client_ip,
    p_client_user_agent => p_client_user_agent,
    p_result          => 'ok'
  );
$$;

REVOKE ALL ON FUNCTION public.log_agent_token_refresh(UUID, UUID, INET, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_agent_token_refresh(UUID, UUID, INET, TEXT) TO service_role;

COMMENT ON FUNCTION public.log_agent_token_refresh IS
  'Writes an agents.token_refreshed audit entry. Called by or-agent-token-refresh on success.';
