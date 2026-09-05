-- quiltt_webhook_inbox: a retired/capped row must never leave processed_at NULL.
--
-- Invariant (from or-quiltt-sync terminal path): retirement_reason and
-- processed_at are written together. This constraint enforces that at the
-- schema level so a future code path cannot silently regress it.
--
-- Reversible:
--   ALTER TABLE public.quiltt_webhook_inbox
--     DROP CONSTRAINT quiltt_webhook_inbox_retired_processed_chk;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quiltt_webhook_inbox_retired_processed_chk'
  ) THEN
    -- NOT VALID first so we do not take a long lock validating existing rows,
    -- then VALIDATE in a second step (only a SHARE UPDATE EXCLUSIVE lock).
    ALTER TABLE public.quiltt_webhook_inbox
      ADD CONSTRAINT quiltt_webhook_inbox_retired_processed_chk
      CHECK (retirement_reason IS NULL OR processed_at IS NOT NULL) NOT VALID;

    ALTER TABLE public.quiltt_webhook_inbox
      VALIDATE CONSTRAINT quiltt_webhook_inbox_retired_processed_chk;
  END IF;
END $$;
