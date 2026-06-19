-- Audit 2026-05-16 High #3 — short-lived widget session tokens for or-link-complete.
--
-- Background: or-link-complete is the endpoint the Connect popup widget hits
-- when a user finishes adding a wallet through an integrating app's flow.
-- It's been unauthenticated since launch — anyone on the public internet can
-- POST garbage and create junk subaccounts + connections under any platform.
-- The wallet contents stay encrypted, so an attacker can't read anyone's
-- data, but they CAN pollute storage and the customer-support dashboard.
--
-- The fix is the standard pattern: integrating apps mint a short-lived
-- one-time token server-to-server BEFORE opening the widget URL. The widget
-- carries the token. or-link-complete verifies + marks the token used.
--
-- This migration adds the storage table. The verification logic ships in
-- the new or-link-mint-token edge function + an update to or-link-complete.

CREATE TABLE IF NOT EXISTS public.pending_widget_sessions (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_id   UUID         NOT NULL REFERENCES public.platforms(id) ON DELETE CASCADE,
  app_user_id   TEXT         NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ  NOT NULL,
  used_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS pending_widget_sessions_expires_idx
  ON public.pending_widget_sessions (expires_at);

CREATE INDEX IF NOT EXISTS pending_widget_sessions_platform_idx
  ON public.pending_widget_sessions (platform_id);

-- RLS: the table is only ever accessed by the service role (from edge
-- functions). End users never read or write it. Defense-in-depth: enable
-- RLS with no policies so anything that tries to read via the anon key
-- gets nothing.
ALTER TABLE public.pending_widget_sessions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.pending_widget_sessions IS
  'Short-lived widget session tokens issued by or-link-mint-token and consumed by or-link-complete. Audit 2026-05-16 High #3. Default expiry: 5 minutes from creation. used_at is set atomically when consumed; verification rejects rows where used_at IS NOT NULL or expires_at < now().';

COMMENT ON COLUMN public.pending_widget_sessions.app_user_id IS
  'The integrating app''s user identifier (V3 user id, V2 org id, etc.). Pinned at mint time so a token issued for user A cannot be replayed against user B.';

-- One-time cleanup: drop expired rows older than 1 hour. Future maintenance
-- (cron / pg_cron task) will run this periodically; for now any caller that
-- needs to keep this lean can run the statement manually.
CREATE OR REPLACE FUNCTION public.cleanup_expired_widget_sessions()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.pending_widget_sessions
    WHERE expires_at < now() - interval '1 hour';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;
