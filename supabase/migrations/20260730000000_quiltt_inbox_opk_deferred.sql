-- quiltt_webhook_inbox: add opk_deferred_at column
--
-- Context: or-quiltt-sync skips inbox events whose subaccount has no OPK
-- (opk_public IS NULL). The old code left processed_at NULL and did not
-- bump attempts, so those rows reappeared at the head of every batch tick
-- forever, blocking drainable events behind them.
--
-- opk_deferred_at is stamped when the event is deferred. The batch query
-- now filters:
--   processed_at IS NULL AND opk_deferred_at IS NULL
-- so deferred rows are invisible until opk_deferred_at is cleared.
--
-- When a subaccount registers its first OPK, the handler must clear
-- opk_deferred_at for all of that subaccount's inbox rows so they
-- re-enter the queue on the next cron tick. That clearing is the
-- responsibility of the OPK-registration path (not added here).

ALTER TABLE public.quiltt_webhook_inbox
  ADD COLUMN IF NOT EXISTS opk_deferred_at TIMESTAMPTZ;

COMMENT ON COLUMN public.quiltt_webhook_inbox.opk_deferred_at IS
  'Set when the event is deferred because subaccounts.opk_public is NULL.
   Clear this when the subaccount registers an OPK so the event re-enters
   the batch queue on the next or-quiltt-sync cron tick.';

-- Replace the old partial index with one that also skips deferred rows.
-- The or-quiltt-sync batch query now filters both columns, and the index
-- must match for Postgres to use it without a full table scan.
DROP INDEX IF EXISTS idx_quiltt_webhook_inbox_pending;
CREATE INDEX IF NOT EXISTS idx_quiltt_webhook_inbox_pending
  ON public.quiltt_webhook_inbox (received_at)
  WHERE processed_at IS NULL AND opk_deferred_at IS NULL;
