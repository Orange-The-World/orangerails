-- quiltt_webhook_inbox.opk_deferred_at (DL-0482)
--
-- Tracks the timestamp at which a webhook row was deferred pending OPK
-- (OpenPaymentKey) registration. The clear guard in or-sync-key-register
-- sets this to NULL once registration is confirmed. NULL means admitted
-- (not deferred).
--
-- NOTE: the set-side (code that defers a row by writing a non-null timestamp)
-- is not yet built. The clearDeferredRows call is a no-op until that path
-- ships. See DL-0482.
--
-- Idempotent: safe to re-run. Metadata-only add (nullable, no default) so it
-- takes no table rewrite and no lock of consequence on a live table.
--
-- Undo: ALTER TABLE public.quiltt_webhook_inbox DROP COLUMN IF EXISTS opk_deferred_at;

ALTER TABLE public.quiltt_webhook_inbox
  ADD COLUMN IF NOT EXISTS opk_deferred_at timestamptz;

COMMENT ON COLUMN public.quiltt_webhook_inbox.opk_deferred_at IS
  'Timestamp at which this row was deferred pending OPK registration. Set by the deferral path (not yet built as of DL-0482); cleared to NULL by clearDeferredRows once OPK registration is confirmed. NULL means admitted (not deferred).';
