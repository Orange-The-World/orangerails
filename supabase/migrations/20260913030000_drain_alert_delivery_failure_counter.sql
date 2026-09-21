-- ============================================================
-- Make repeated or-quiltt-drain-alert delivery failures directly
-- assertable from PostgreSQL (OR-T1135).
--
-- last_attempt_at and last_error make the most recent failure durable. This
-- counter distinguishes an isolated miss from a notifier that remains dead
-- across evaluations, without changing the existing cooldown contract:
-- last_notified_at remains the only cooldown key and advances on success only.
--
-- Down / undo (run manually to remove this migration):
--   ALTER TABLE public.drain_alert_state
--     DROP COLUMN IF EXISTS consecutive_failures;
-- ============================================================

ALTER TABLE public.drain_alert_state
  ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_failures >= 0);

COMMENT ON COLUMN public.drain_alert_state.consecutive_failures IS
  'Number of consecutive failed Zulip post attempts. Incremented after each '
  'failure and reset to zero after success; does not control cooldown (OR-T1135).';
