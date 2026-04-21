-- Create vault_security_events table for audit log of vault key-material events
CREATE TABLE IF NOT EXISTS public.vault_security_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event      TEXT NOT NULL,
  metadata   JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.vault_security_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can insert their own vault security events"
  ON public.vault_security_events FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can read their own vault security events"
  ON public.vault_security_events FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_vault_security_events_user_created
  ON public.vault_security_events(user_id, created_at DESC);

COMMENT ON TABLE public.vault_security_events IS
  'Audit log for user-level vault key events: setup, unlock, recover, password_changed.';

COMMENT ON COLUMN public.vault_security_events.event IS
  'Short event code: vault_setup | vault_unlock | vault_unlock_failed | vault_recover | vault_password_changed';