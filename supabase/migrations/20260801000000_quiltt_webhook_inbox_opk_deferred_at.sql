-- Own quiltt_webhook_inbox.opk_deferred_at in migration history.
--
-- Context: this column exists on dev (added out of band) but no migration
-- file owned it, so prod would never receive it. Reconstructed here from the
-- live dev column definition: timestamptz, nullable, no default.
--
-- Idempotent: IF NOT EXISTS makes this a no-op where the column already
-- exists and the change where it does not.
alter table public.quiltt_webhook_inbox
  add column if not exists opk_deferred_at timestamptz;

-- Undo (safe only while the column holds no data you need):
-- alter table public.quiltt_webhook_inbox drop column if exists opk_deferred_at;
