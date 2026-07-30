-- migration: add retirement_reason to quiltt_webhook_inbox (DL-0465)
--
-- The terminal guard in or-quiltt-sync writes this column when a row
-- reaches MAX_ATTEMPTS. Without it, retired rows are byte-identical to
-- genuine successes (both have processed_at set, last_error present,
-- retirement_reason NULL), making dead-letter state invisible.
--
-- IF NOT EXISTS: dev already has the column via direct DDL (SQLA-00060);
-- prod does not. Both can apply this safely.
ALTER TABLE public.quiltt_webhook_inbox
  ADD COLUMN IF NOT EXISTS retirement_reason TEXT;
