-- quiltt_webhook_inbox.opk_deferred_at (DL-0426)
--
-- Records when a webhook row was parked by the deferred-OPK path for later
-- re-admission once the OPK is available. NULL until a row is deferred.
--
-- Idempotent: safe to re-run. Metadata-only add (nullable, no default) so it
-- takes no table rewrite and no lock of consequence on a live table.
-- No-op on dev where the column already exists via out-of-band DDL.
--
-- Undo: ALTER TABLE public.quiltt_webhook_inbox DROP COLUMN IF EXISTS opk_deferred_at;

ALTER TABLE public.quiltt_webhook_inbox
  ADD COLUMN IF NOT EXISTS opk_deferred_at timestamptz;

COMMENT ON COLUMN public.quiltt_webhook_inbox.opk_deferred_at IS
  'Timestamp when a webhook row was parked by the deferred-OPK path for later re-admission. NULL until a row is deferred.';
