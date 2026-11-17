-- OR-T0954: port complete_agent_invitation raw-token design to self-hosted cluster
-- Design: p_token text, sha256 hashed internally (RULING b, cryptography-engineer, 2026-08-31).
-- Ports the design of migration 20260831110000 to the self-hosted cluster (Magnus supabase-db).
-- Self-hosted keeps anon EXECUTE per OR-T0937.
-- Hosted Supabase projects already have this design via migration 20260831110000; applying
-- this migration to them is safe (idempotent) but not required.

BEGIN;

-- Remove old UUID-based overload if still present on self-hosted.
-- On hosted clusters this is already gone (dropped by 20260831110000); DROP IF EXISTS is a no-op.
DROP FUNCTION IF EXISTS public.complete_agent_invitation(uuid, uuid, text, text);

-- Create or update with raw-token signature.
-- Body is identical to the version deployed to hosted clusters by migration 20260831110000.
CREATE OR REPLACE FUNCTION public.complete_agent_invitation(
  p_token           text,
  p_shadow_user_id  uuid,
  p_identity_pubkey text,
  p_kem_pubkey      text
)
RETURNS TABLE (
  agent_member_id uuid,
  owner_user_id   uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $complete$
DECLARE
  v_agent_member_id uuid;
  v_owner_user_id   uuid;
  v_invitation_id   uuid;
  v_token_hash      text;
BEGIN
  IF p_identity_pubkey IS NULL
     OR length(p_identity_pubkey) < 40
     OR length(p_identity_pubkey) > 1024 THEN
    RAISE EXCEPTION 'identity_pubkey missing or invalid length';
  END IF;
  IF p_kem_pubkey IS NULL
     OR length(p_kem_pubkey) < 40
     OR length(p_kem_pubkey) > 4096 THEN
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

  -- Malformed token: same message as unknown, expired, revoked or already
  -- redeemed. Deliberate.
  IF p_token IS NULL
     OR length(p_token) < 43
     OR length(p_token) > 512
     OR p_token !~ '^[A-Za-z0-9_=-]+$' THEN
    RAISE EXCEPTION 'Invitation could not be completed';
  END IF;

  v_token_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');

  SELECT t.id, t.agent_member_id, t.owner_user_id
    INTO v_invitation_id, v_agent_member_id, v_owner_user_id
    FROM public.agent_invitation_tokens t
   WHERE t.token_hash  = v_token_hash
     AND t.redeemed_at IS NULL
     AND t.revoked_at  IS NULL
     AND t.expires_at  > now()
   FOR UPDATE;

  IF v_agent_member_id IS NULL THEN
    RAISE EXCEPTION 'Invitation could not be completed';
  END IF;

  UPDATE public.agent_members
     SET shadow_user_id   = p_shadow_user_id,
         identity_pubkey  = p_identity_pubkey,
         kem_pubkey       = p_kem_pubkey,
         activated_at     = now(),
         last_activity_at = now()
   WHERE id = v_agent_member_id
     AND activated_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation could not be completed';
  END IF;

  UPDATE public.agent_invitation_tokens
     SET redeemed_at = now()
   WHERE id = v_invitation_id;

  PERFORM public.append_audit_entry(
    p_action          => 'agents.invite_redeemed',
    p_actor_user_id   => p_shadow_user_id,
    p_actor_member_id => v_agent_member_id,
    p_resource_type   => 'agent_member',
    p_resource_id     => v_agent_member_id::text,
    p_result          => 'ok'
  );

  RETURN QUERY SELECT v_agent_member_id, v_owner_user_id;
END;
$complete$;

-- ACL: revoke broad PUBLIC grant, then grant to service_role.
-- anon EXECUTE is NOT granted by this migration. Migration 20260831100000 revokes the anon
-- schema default, so the function lands with no anon EXECUTE on both hosted and self-hosted.
--
-- To deliver OR-T0937 (anon callable on self-hosted only), the DBA must run the following
-- on the self-hosted cluster (Magnus supabase-db) AFTER applying this migration:
--   GRANT EXECUTE ON FUNCTION public.complete_agent_invitation TO anon;
-- This is intentionally outside the shared migrations so hosted Supabase projects (dev, prod)
-- do not receive anon EXECUTE (OR-T0988).
--
-- The grant is NOT declared in supabase/anon-executable-rpcs.json because no migration
-- backs it; the CI gate would report it as stale. The DBA grant is tracked in OR-T0954.
REVOKE ALL ON FUNCTION public.complete_agent_invitation(text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_agent_invitation(text, uuid, text, text) TO service_role;

COMMIT;
