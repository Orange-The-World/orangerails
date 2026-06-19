-- ============================================================
-- Quiltt-specific tables: profile mapping + webhook inbox.
-- Foundation for or-quiltt-webhook + or-quiltt-sync edge functions.
-- Wiki page 10 — "OR Quiltt integration (canonical, code-grounded)".
-- ============================================================

-- ── quiltt_profile_map ──────────────────────────────────────────────
-- One row per (platform, app_user) that has linked a bank via Quiltt.
-- The Quiltt Profile id is the join key on inbound webhooks: every
-- Quiltt webhook payload includes a profile.id, we look it up here to
-- find which OR subaccount + which OR platform the event belongs to.

CREATE TABLE IF NOT EXISTS public.quiltt_profile_map (
  subaccount_id          UUID PRIMARY KEY REFERENCES public.subaccounts(id) ON DELETE CASCADE,
  platform_id            UUID NOT NULL REFERENCES public.platforms(id) ON DELETE CASCADE,
  quiltt_profile_id      TEXT NOT NULL,
  quiltt_environment_id  TEXT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform_id, quiltt_profile_id)
);

COMMENT ON TABLE public.quiltt_profile_map IS
  'Bidirectional map between OR subaccounts and Quiltt Profile ids. Created when or-link-complete persists a fresh Quiltt link; consulted by or-quiltt-webhook to route events back to the right platform/subaccount.';
COMMENT ON COLUMN public.quiltt_profile_map.quiltt_environment_id IS
  'Records which Quiltt environment minted this Profile (Model A → OR shared env, Model B → tenant-owned env). Lets webhook routing distinguish a Model-B tenant''s traffic from the bundled pipe.';

-- Index for the reverse lookup (subaccount → quiltt_profile_id) is
-- already covered by the PK. The unique constraint above covers the
-- forward lookup (quiltt_profile_id → subaccount).

CREATE INDEX IF NOT EXISTS idx_quiltt_profile_map_environment
  ON public.quiltt_profile_map (quiltt_environment_id);

-- RLS — platform-scoped read, service-role write (matches the
-- platforms/subaccounts pattern). Edge functions use the service role,
-- so denial-by-default policies are sufficient.

ALTER TABLE public.quiltt_profile_map ENABLE ROW LEVEL SECURITY;
-- (No policies = deny by default; edge functions use service role to bypass.)

-- ── quiltt_webhook_inbox ────────────────────────────────────────────
-- Idempotent staging table for inbound Quiltt webhook events. The
-- webhook receiver (or-quiltt-webhook) returns 200 within Quiltt's
-- 20-second budget by inserting the event here and acking; the worker
-- (or-quiltt-sync) drains the inbox asynchronously, deduping on
-- event_id so Quiltt's 20-attempt retry policy is safe.

CREATE TABLE IF NOT EXISTS public.quiltt_webhook_inbox (
  event_id      TEXT PRIMARY KEY,                -- from event.id in payload
  event_type    TEXT NOT NULL,                   -- e.g. connection.synced.successful.initial
  platform_id   UUID REFERENCES public.platforms(id) ON DELETE SET NULL,
  subaccount_id UUID REFERENCES public.subaccounts(id) ON DELETE SET NULL,
  payload       JSONB NOT NULL,                  -- full event body for replay/debugging
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT
);

COMMENT ON TABLE public.quiltt_webhook_inbox IS
  'Idempotent staging table for Quiltt webhook events. or-quiltt-webhook inserts on receipt; or-quiltt-sync worker drains.';
COMMENT ON COLUMN public.quiltt_webhook_inbox.payload IS
  'Full event body. Stored for replay and for the case where the platform_id/subaccount_id lookup fails (e.g. event arrives before or-link-complete persisted the mapping).';

-- Partial index for the worker — only scan unprocessed rows.
CREATE INDEX IF NOT EXISTS idx_quiltt_webhook_inbox_pending
  ON public.quiltt_webhook_inbox (received_at)
  WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_quiltt_webhook_inbox_platform
  ON public.quiltt_webhook_inbox (platform_id)
  WHERE platform_id IS NOT NULL;

ALTER TABLE public.quiltt_webhook_inbox ENABLE ROW LEVEL SECURITY;
-- Deny by default; edge functions use service role.

-- Note: payload retention. The worker should null/truncate payload
-- ~30 days after processed_at, leaving only the metadata (event_id,
-- type, timestamps) for audit. A separate housekeeping migration adds
-- the cleanup function once the worker ships.
