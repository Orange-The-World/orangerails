-- Add content-based dedup snapshot to drain_alert_state (OR-T2708).
--
-- or-quiltt-drain-alert currently reposts every 60 min while any signal
-- fires, even when the state is identical to the last post (same signals,
-- same counts). This migration adds last_signal_snapshot jsonb so the
-- function can compare current state against what it last posted and
-- suppress when unchanged, re-alerting only when the snapshot changes or
-- a 6-hour re-alert ceiling is hit.
--
-- Down / undo:
--   ALTER TABLE public.drain_alert_state DROP COLUMN IF EXISTS last_signal_snapshot;

ALTER TABLE public.drain_alert_state
  ADD COLUMN IF NOT EXISTS last_signal_snapshot jsonb;

COMMENT ON COLUMN public.drain_alert_state.last_signal_snapshot IS
  'Signal state at the time of the last successful Zulip post. '
  'Used by the edge function to suppress reposts of an unchanged alert state. '
  'A NULL value (no previous post) forces a post on the next firing run (OR-T2708).';
