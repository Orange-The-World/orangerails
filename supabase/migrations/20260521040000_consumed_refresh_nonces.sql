-- ============================================================
-- consumed_refresh_nonces — replay-protection ledger for
-- or-agent-token-refresh
-- ============================================================
-- Audit finding H2 (2026-05-21):
-- The signed_payload in or-agent-token-refresh was called a "nonce" in
-- comments but had no nonce-tracking table behind it. A captured
-- request could be replayed within the NONCE_WINDOW_SECONDS (60s)
-- clock window to mint additional 1-hour JWTs without re-signing.
--
-- Solution: track every consumed payload hash per agent_member_id. The
-- UNIQUE constraint catches replay — on second use, the INSERT raises
-- 23505 and the edge function returns 401.
--
-- Rows older than NONCE_WINDOW_SECONDS are safe to GC; the consumed_at
-- index supports that cleanup.

CREATE TABLE IF NOT EXISTS public.consumed_refresh_nonces (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_member_id UUID         NOT NULL REFERENCES public.agent_members(id) ON DELETE CASCADE,
  payload_hash    BYTEA        NOT NULL,
  consumed_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (agent_member_id, payload_hash)
);

CREATE INDEX IF NOT EXISTS consumed_refresh_nonces_consumed_at_idx
  ON public.consumed_refresh_nonces (consumed_at);

ALTER TABLE public.consumed_refresh_nonces ENABLE ROW LEVEL SECURITY;
-- No policies — service role only. Authenticated users cannot read these.

REVOKE ALL ON public.consumed_refresh_nonces FROM PUBLIC;
REVOKE ALL ON public.consumed_refresh_nonces FROM authenticated, anon;
GRANT SELECT, INSERT, DELETE ON public.consumed_refresh_nonces TO service_role;

COMMENT ON TABLE public.consumed_refresh_nonces IS
  'Replay-protection ledger for or-agent-token-refresh. One row per (agent_member_id, payload_hash). UNIQUE catches replay; rows older than NONCE_WINDOW_SECONDS can be GC''d.';
