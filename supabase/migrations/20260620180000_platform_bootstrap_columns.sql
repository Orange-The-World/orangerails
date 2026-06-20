-- Platform bootstrap (single-key auth + config discovery).
--
-- Adds the columns the bootstrap endpoint will return to consumers so
-- they no longer hardcode OR_BASE_URL, NEXT_PUBLIC_OR_LINK_WIDGET_URL,
-- webhook secrets, etc., in their own .env. Consumer .env shrinks to
-- one value (OR_API_KEY) plus the well-known bootstrap URL.
--
-- KEY-FORMAT BACKWARD COMPATIBILITY: this migration does NOT rotate
-- any existing api_key_hash values. V2's current OR_PLATFORM_API_KEY
-- (the hex64 string starting 9dd1911...) continues to authenticate
-- unchanged. The new prefixed format <slug>_<env>_<random32> is the
-- recommended shape for new platforms; existing BitBooks-family keys
-- can migrate later or never. Bootstrap endpoint accepts both shapes
-- because the hash function is the same.
--
-- See Consumer Integration Guide §3 (Authentication) and the
-- 2026-06-20 Roadmap entry for the architectural framing.

BEGIN;

-- ============================================================
-- 1. Bootstrap response + lifecycle columns
-- ============================================================

ALTER TABLE public.platforms
  ADD COLUMN IF NOT EXISTS widget_url        TEXT,
  ADD COLUMN IF NOT EXISTS webhook_secret    TEXT,
  ADD COLUMN IF NOT EXISTS app_profile_slug  TEXT,
  ADD COLUMN IF NOT EXISTS status            TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS rotated_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bootstrap_ttl_seconds INTEGER NOT NULL DEFAULT 3600,
  ADD COLUMN IF NOT EXISTS env               TEXT NOT NULL DEFAULT 'live';

-- status: lifecycle marker. Bootstrap returns 403 for non-active rows.
ALTER TABLE public.platforms
  ADD CONSTRAINT platforms_status_check
  CHECK (status IN ('active', 'suspended', 'revoked'));

-- env: which OR backend a platform belongs to. Old-format keys (V2's
-- hex64) require a DB lookup to determine env; new prefixed keys
-- (bbv2_live_xxx) carry the env in the prefix and don't need this
-- column for routing. Either way, the row's env is authoritative.
ALTER TABLE public.platforms
  ADD CONSTRAINT platforms_env_check
  CHECK (env IN ('live', 'test', 'dev'));

COMMENT ON COLUMN public.platforms.widget_url IS
  'Origin where the OR Link widget for this platform is hosted. Returned as widget_url in /v1/platform/config response.';
COMMENT ON COLUMN public.platforms.webhook_secret IS
  'HMAC-SHA256 secret used to sign inbound webhooks OR sends to this platform AND for the platform to verify them. Returned in the bootstrap response so the consumer can configure its verifier.';
COMMENT ON COLUMN public.platforms.app_profile_slug IS
  'Which sink-config YAML this platform uses (see _shared/sinks/profiles/). Returned so the consumer can pick the right sink at runtime.';
COMMENT ON COLUMN public.platforms.status IS
  'Lifecycle: active (normal), suspended (temporary block), revoked (terminated). Bootstrap returns 403 for non-active.';
COMMENT ON COLUMN public.platforms.rotated_at IS
  'When the api_key was last rotated. Lets the bootstrap response surface a stale-key hint. NULL if never rotated.';
COMMENT ON COLUMN public.platforms.bootstrap_ttl_seconds IS
  'How long the consumer should cache the bootstrap response before refetching. Per-platform override; default one hour.';
COMMENT ON COLUMN public.platforms.env IS
  'Which OR environment this row belongs to (live | test | dev). Old hex64 keys are routed to env via DB lookup; new prefixed keys carry env in the prefix.';

-- ============================================================
-- 2. Backfill the 5 known platforms
-- ============================================================
-- This migration runs separately on each OR Supabase project (DEV +
-- PROD). On PROD it backfills env='live'. The DEV variant of this
-- migration (same file applied separately) overrides env to 'dev'.

UPDATE public.platforms
SET widget_url       = COALESCE(widget_url, 'https://connect.orangerails.com'),
    app_profile_slug = COALESCE(app_profile_slug, slug),
    env              = 'live'
WHERE slug IN ('bbv2', 'bbv3', 'owm', 'owb', 'direct');

-- ============================================================
-- 3. RLS on new columns
-- ============================================================
-- platforms has RLS enabled. Existing service-role bypass (used by all
-- edge functions including the new bootstrap) is sufficient. No new
-- policy needed; additive columns inherit the existing posture.

COMMIT;
