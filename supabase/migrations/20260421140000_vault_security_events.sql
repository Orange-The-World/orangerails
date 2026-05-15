-- ============================================================
-- vault_security_events — audit log for vault key-material events.
-- ============================================================
-- Scope: user-level authentication + key-management events (vault
-- setup, unlock, recover, password change). OrangeRails has no
-- org-level audit log; this is the single source for key events.
--
-- Background: src/lib/audit.ts emits inserts into this table on
-- unlock/setup/recover/change-password. Without this table, every
-- such action produces a 404 Not Found in the browser console.
--
-- Privacy: event names are short codes (e.g. 'vault_unlock'), not
-- free-form strings. metadata is a JSONB blob for low-sensitivity
-- context (e.g. key_version). Never put plaintext or PII here.

CREATE TABLE IF NOT EXISTS public.vault_security_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event      TEXT NOT NULL,
  metadata   JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.vault_security_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can insert their own vault security events" ON public.vault_security_events;
CREATE POLICY "Users can insert their own vault security events"
  ON public.vault_security_events FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can read their own vault security events" ON public.vault_security_events;
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
