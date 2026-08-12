-- DL-0443 Stealth Sync instrumentation: record every sync attempt, not only success.
--
-- Problem: the only durable per-connection signal today is last_sync_at, which is
-- written on success. When a sync is attempted but the cursor write fails, nothing is
-- recorded, so a never-attempted connection is indistinguishable from an attempted one
-- that failed. That is why the 7 prod connections with zero completed syncs cannot be
-- classified.
--
-- Fix: a bare attempt timestamp on the connection row, set server-side in
-- or-stealth-envelope-update at the start of each sync attempt (before runSync). Same
-- data class as last_sync_at: a timestamp only, no scanned addresses, blocks, or counts,
-- so this stays off the self-custody surface.
--
-- Reversible: yes. Down path:
--   ALTER TABLE public.stealth_connections DROP COLUMN IF EXISTS last_sync_attempt_at;
-- Idempotent: ADD COLUMN IF NOT EXISTS, so a re-run is a no-op. Nullable with no
-- constraint, so it is safe to land ahead of the server-side writer; rows stay NULL
-- until the writer ships.

ALTER TABLE public.stealth_connections
  ADD COLUMN IF NOT EXISTS last_sync_attempt_at timestamptz;

COMMENT ON COLUMN public.stealth_connections.last_sync_attempt_at IS
  'Set server-side at the start of each sync attempt (before runSync). Bare timestamp only, no scan targets. Distinguishes never-attempted from attempted-but-cursor-write-failed.';
