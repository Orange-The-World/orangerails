-- source-control catch-up: add opk_deferred_at to quiltt_webhook_inbox.
--
-- The column was applied to the dev database out of band during DL-0481/DL-0482
-- work. This migration records the exact DDL in source control so the prod
-- apply (two-party: CTO + founder) has a single file to run.
--
-- Purpose: or-quiltt-sync stamps opk_deferred_at when a subaccount has no OPK
-- yet, parking the row without consuming it. or-sync-key-register clears it
-- (sets NULL) after the key is registered, re-admitting the row to the next
-- sync batch (clearDeferredRows, PR #321 / DL-0482).
--
-- Ordering: this migration must be applied to prod BEFORE the or-quiltt-sync
-- and or-sync-key-register functions are promoted. Function-first order would
-- reference a column that does not yet exist on prod.
--
-- Rollback:
--   ALTER TABLE public.quiltt_webhook_inbox DROP COLUMN IF EXISTS opk_deferred_at;
--   DROP INDEX IF EXISTS idx_quiltt_webhook_inbox_deferred;

ALTER TABLE public.quiltt_webhook_inbox
  ADD COLUMN IF NOT EXISTS opk_deferred_at TIMESTAMPTZ;

COMMENT ON COLUMN public.quiltt_webhook_inbox.opk_deferred_at IS
  'Set (to now()) when or-quiltt-sync parks this row because the subaccount has no OPK. '
  'Cleared (NULL) by or-sync-key-register once the key is registered, re-admitting '
  'the row to the next sync batch. NULL means eligible for normal processing.';

-- Partial index: speeds up or-sync-key-register clearDeferredRows queries
-- (filter: subaccount_id = X AND opk_deferred_at IS NOT NULL).
CREATE INDEX IF NOT EXISTS idx_quiltt_webhook_inbox_deferred
  ON public.quiltt_webhook_inbox (subaccount_id)
  WHERE opk_deferred_at IS NOT NULL;
