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

-- Rebuild the partial index so pending-queue scans exclude deferred rows.
-- The predicate cannot be ALTERed in place, so drop and recreate.
-- Column must exist before the index predicate can reference it (above).
drop index if exists public.idx_quiltt_webhook_inbox_pending;
create index if not exists idx_quiltt_webhook_inbox_pending
  on public.quiltt_webhook_inbox using btree (received_at)
  where ((processed_at is null) and (opk_deferred_at is null));

-- Undo (safe only while the column holds no data you need):
-- 1) restore the original index predicate (without opk_deferred_at):
--    drop index if exists idx_quiltt_webhook_inbox_pending;
--    create index if not exists idx_quiltt_webhook_inbox_pending
--      on public.quiltt_webhook_inbox (received_at)
--      where processed_at is null;
-- 2) then drop the column:
--    alter table public.quiltt_webhook_inbox drop column if exists opk_deferred_at;
