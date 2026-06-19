-- ============================================================
-- Agent Invitation Tokens — one-time tokens for agent CLI redemption
-- ============================================================
-- See: docs/OrangeRails-Agent-Members.md
--
-- Companion to agent_members. When an owner clicks "Invite Claude" in the
-- dashboard, an agent_members row is created (pubkeys NULL, activated_at NULL)
-- AND a row in this table holding a hash of the one-time invitation token.
--
-- The raw token is returned to the owner once (shown in the dashboard,
-- ready to copy into the agent's CLI). It is never stored anywhere except
-- as a SHA-256 hash in token_hash. Same pattern as GitHub PATs, npm tokens,
-- and the existing user_app_grants access tokens.
--
-- Lifecycle states:
--   - Pending: redeemed_at IS NULL AND revoked_at IS NULL AND now() < expires_at
--   - Redeemed: redeemed_at IS NOT NULL (terminal, success)
--   - Revoked: revoked_at IS NOT NULL (terminal, owner cancelled before redeem)
--   - Expired: now() >= expires_at AND redeemed_at IS NULL AND revoked_at IS NULL
--
-- Mint and redeem functions live in subsequent migrations
-- respectively).

-- ============================================================
-- 1. Table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.agent_invitation_tokens (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_member_id   UUID         NOT NULL REFERENCES public.agent_members(id) ON DELETE CASCADE,
  owner_user_id     UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- SHA-256 hex of the raw 256-bit invitation token. Server validates by
  -- hashing the incoming token and comparing. Raw token never stored.
  token_hash        TEXT         NOT NULL UNIQUE,

  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ  NOT NULL,         -- 7 days from created_at by default (set in mint function)
  redeemed_at       TIMESTAMPTZ,                    -- non-null = successfully consumed
  revoked_at        TIMESTAMPTZ,                    -- non-null = owner cancelled before redemption

  -- For UI display: which IP / user agent the owner created the invitation from
  created_from_ip   INET,
  created_from_ua   TEXT,

  CONSTRAINT agent_invitation_tokens_terminal_one_only
    CHECK (NOT (redeemed_at IS NOT NULL AND revoked_at IS NOT NULL))
);

COMMENT ON TABLE public.agent_invitation_tokens IS
  'One-time tokens for redeeming an agent_members invitation via CLI. Hash-only storage. 7-day TTL per Decision 3.';

COMMENT ON COLUMN public.agent_invitation_tokens.token_hash IS
  'SHA-256 hex (64 chars) of the raw 256-bit invitation token. Server validates by hashing input and comparing.';

COMMENT ON COLUMN public.agent_invitation_tokens.expires_at IS
  'Set to created_at + 7 days by the mint function. After this, the token is no longer redeemable.';

-- ============================================================
-- 2. Indexes
-- ============================================================
-- Already UNIQUE on token_hash; PRIMARY KEY on id.

CREATE INDEX IF NOT EXISTS agent_invitation_tokens_owner_idx
  ON public.agent_invitation_tokens(owner_user_id)
  WHERE redeemed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS agent_invitation_tokens_agent_member_idx
  ON public.agent_invitation_tokens(agent_member_id);

-- Cleanup index: pending tokens past expiry
CREATE INDEX IF NOT EXISTS agent_invitation_tokens_expired_pending_idx
  ON public.agent_invitation_tokens(expires_at)
  WHERE redeemed_at IS NULL AND revoked_at IS NULL;

-- ============================================================
-- 3. Row Level Security
-- ============================================================
ALTER TABLE public.agent_invitation_tokens ENABLE ROW LEVEL SECURITY;

-- Owner can read their own invitation tokens (so the dashboard can show
-- "pending invitation expires in 5 days" with a revoke button).
-- NOTE: token_hash is exposed to the owner; that is intentional (it is a
-- hash, not the raw token; the raw token was already returned to them at
-- mint time and is in their copy-paste buffer / their CLI history).
DROP POLICY IF EXISTS "Owners read own invitation tokens" ON public.agent_invitation_tokens;
CREATE POLICY "Owners read own invitation tokens"
  ON public.agent_invitation_tokens FOR SELECT
  TO authenticated
  USING (owner_user_id = auth.uid());

-- No INSERT/UPDATE/DELETE policy: all mutations go through SECURITY DEFINER
-- functions (mint, redeem, revoke, cleanup). Clients cannot create or
-- modify rows directly.

-- ============================================================
-- 4. revoke_agent_invitation_token(token_id UUID) — owner cancels a pending invitation
-- ============================================================
CREATE OR REPLACE FUNCTION public.revoke_agent_invitation_token(p_token_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner UUID;
  v_state TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: no auth context';
  END IF;

  SELECT
    owner_user_id,
    CASE
      WHEN redeemed_at IS NOT NULL THEN 'redeemed'
      WHEN revoked_at IS NOT NULL THEN 'revoked'
      WHEN expires_at < now() THEN 'expired'
      ELSE 'pending'
    END
  INTO v_owner, v_state
  FROM public.agent_invitation_tokens
  WHERE id = p_token_id;

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Invitation token not found';
  END IF;

  IF v_owner <> auth.uid() THEN
    RAISE EXCEPTION 'Forbidden: caller is not the owner of this invitation';
  END IF;

  IF v_state <> 'pending' THEN
    -- Idempotent: revoking an already-terminal token returns false but does not error.
    RETURN FALSE;
  END IF;

  UPDATE public.agent_invitation_tokens
  SET revoked_at = now()
  WHERE id = p_token_id;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_agent_invitation_token(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_agent_invitation_token(UUID) TO authenticated;

COMMENT ON FUNCTION public.revoke_agent_invitation_token(UUID) IS
  'Owner cancels a pending invitation before the agent redeems it. Returns true if revoked, false if already terminal (idempotent).';

-- ============================================================
-- 5. cleanup_expired_agent_invitation_tokens() — cron-callable maintenance
-- ============================================================
-- Deletes pending tokens that have passed expires_at. Redeemed tokens are
-- kept indefinitely (they are part of the agent_members audit trail).
-- Revoked tokens are kept for 30 days then deleted (transient state, no
-- need to keep forever).

CREATE OR REPLACE FUNCTION public.cleanup_expired_agent_invitation_tokens()
RETURNS TABLE(deleted_count INT, retained_count INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INT;
  v_retained INT;
BEGIN
  -- Delete: expired-pending older than 24 hours, or revoked older than 30 days
  WITH del AS (
    DELETE FROM public.agent_invitation_tokens
    WHERE
      (redeemed_at IS NULL AND revoked_at IS NULL AND expires_at < now() - interval '1 day')
      OR
      (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')
    RETURNING 1
  )
  SELECT count(*)::INT INTO v_deleted FROM del;

  SELECT count(*)::INT INTO v_retained FROM public.agent_invitation_tokens;

  RETURN QUERY SELECT v_deleted, v_retained;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_expired_agent_invitation_tokens() FROM PUBLIC;
-- Only service_role can run cleanup. Schedule via pg_cron in a separate
-- migration once the rest of Phase 1 lands.

COMMENT ON FUNCTION public.cleanup_expired_agent_invitation_tokens() IS
  'Maintenance: deletes pending tokens past 24h-after-expiry, and revoked tokens past 30d. Returns (deleted_count, retained_count).';
