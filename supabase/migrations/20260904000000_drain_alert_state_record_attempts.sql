-- ============================================================
-- Record failed or-quiltt-drain-alert Zulip post attempts, not only
-- successful ones (OR-T1135, follows DL-0640 / 20260811000000).
--
-- Before this migration, drain_alert_state carried only last_notified_at,
-- written exclusively when a Zulip post succeeded. A failed post left the
-- table untouched, so the notifier being dead was indistinguishable from
-- the notifier being fine to any SQL query. This alarm never once posted
-- successfully and it took a code review of an unrelated ticket to notice.
--
-- last_notified_at keeps its existing meaning (success only) and its
-- existing role gating the 60-minute repost cooldown. This migration adds
-- two columns the edge function writes on EVERY attempt, success or
-- failure, so a dead notifier leaves a durable trace:
--   last_attempt_at  -- when the last post attempt happened, regardless of outcome
--   last_error       -- short reason for the most recent failure; NULL after a success
--
-- Down / undo (run manually to remove this migration):
--   ALTER TABLE public.drain_alert_state DROP COLUMN IF EXISTS last_attempt_at;
--   ALTER TABLE public.drain_alert_state DROP COLUMN IF EXISTS last_error;
-- ============================================================

ALTER TABLE public.drain_alert_state
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error       TEXT;

COMMENT ON COLUMN public.drain_alert_state.last_attempt_at IS
  'When the notifier last attempted a Zulip post, success or failure. '
  'Written on every attempt so a dead notifier is visible to a DB query (OR-T1135).';

COMMENT ON COLUMN public.drain_alert_state.last_error IS
  'Short reason for the most recent failed post attempt (missing env var name, '
  'or "HTTP <status>: <body prefix>", or a thrown error message). NULL after a '
  'successful post. Never engages the repost cooldown, which stays keyed off '
  'last_notified_at (OR-T1135).';
