-- quiltt_webhook_inbox.retirement_reason and stealth catch-up (DL-0326 / DL-0465 / DL-0443)
--
-- PRIMARY PURPOSE: add retirement_reason to quiltt_webhook_inbox.
-- Records the reason a webhook row was permanently retired by the drain's
-- terminal guard (e.g. "max-attempts:<err>"). NULL until a row is retired.
--
-- WHY THIS VERSION: the column was first written at 20260730120000, a version
-- prefix that was already taken. Supabase records a version once and skips the
-- later file alphabetically, so the column never landed on prod. 20260809120000
-- is also taken (stealth_add_last_sync_attempt_at, DL-0443), so this settles at
-- 20260809130000, which is free on both the dev and prod ledgers.
--
-- CATCH-UP: also ensures last_sync_attempt_at lands on stealth_connections on prod,
-- since that file was itself skipped by the earlier collision. Idempotent, so it is
-- a no-op on dev where the column already exists.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, nullable, no default. Metadata-only, no
-- table rewrite, no lock of consequence on a live table.
--
-- Undo:
--   ALTER TABLE public.quiltt_webhook_inbox DROP COLUMN IF EXISTS retirement_reason;
--   ALTER TABLE public.stealth_connections DROP COLUMN IF EXISTS last_sync_attempt_at;
--
-- Refs: DL-0647, DL-0326, DL-0465, DL-0443

-- Stealth catch-up (idempotent; skipped on prod by the earlier prefix collision)
ALTER TABLE public.stealth_connections
  ADD COLUMN IF NOT EXISTS last_sync_attempt_at timestamptz;

COMMENT ON COLUMN public.stealth_connections.last_sync_attempt_at IS
  'Set server-side at the start of each sync attempt (before runSync). Bare timestamp only, no scan targets. Distinguishes never-attempted from attempted-but-cursor-write-failed.';

-- Primary purpose: retirement reason tracking
ALTER TABLE public.quiltt_webhook_inbox
  ADD COLUMN IF NOT EXISTS retirement_reason text;

COMMENT ON COLUMN public.quiltt_webhook_inbox.retirement_reason IS
  'Reason a webhook row was permanently retired by the drain terminal guard (e.g. max-attempts:<err>). NULL until retirement.';
