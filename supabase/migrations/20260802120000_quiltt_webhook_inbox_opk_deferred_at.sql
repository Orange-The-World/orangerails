-- Add opk_deferred_at to public.quiltt_webhook_inbox.
--
-- Regularizes git against a schema change applied directly to dev and never
-- written as a file. The or-sync-key-register edge function sets and filters
-- on this column; prod does not have it, so the function errors there.
--
-- Idempotent: dev already has the column, so this is a no-op there; prod gains
-- it. Type and nullability match dev (timestamptz, nullable, no default).
--
-- Reverse: ALTER TABLE public.quiltt_webhook_inbox DROP COLUMN IF EXISTS
-- opk_deferred_at; (safe only after the dependent edge function is reverted).

ALTER TABLE public.quiltt_webhook_inbox
  ADD COLUMN IF NOT EXISTS opk_deferred_at timestamptz;
