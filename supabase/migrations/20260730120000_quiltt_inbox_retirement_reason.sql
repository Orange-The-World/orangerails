-- quiltt_webhook_inbox.retirement_reason (DL-0326 / DL-0465)
--
-- Records the reason a webhook row was permanently retired by the drain's
-- terminal guard (e.g. "max-attempts:<err>"). NULL until a row is retired.
--
-- Idempotent: safe to re-run. Metadata-only add (nullable, no default) so it
-- takes no table rewrite and no lock of consequence on a live table.
--
-- Undo: ALTER TABLE public.quiltt_webhook_inbox DROP COLUMN IF EXISTS retirement_reason;

ALTER TABLE public.quiltt_webhook_inbox
  ADD COLUMN IF NOT EXISTS retirement_reason text;

COMMENT ON COLUMN public.quiltt_webhook_inbox.retirement_reason IS
  'Reason a webhook row was permanently retired by the drain terminal guard (e.g. max-attempts:<err>). NULL until retirement.';
