-- ============================================================
-- Register the bitbooks-v2 platform + add display columns
-- ============================================================
-- Adds the per-platform display attributes that the /connect Link
-- widget needs to render Plaid-hybrid co-branding (the integrating
-- app's name on top, "Powered by Orange Rails" smaller below) and
-- registers the bitbooks-v2 platform row used by V2's thin-slice
-- integration.
--
-- The CORS allow-list lives in _shared/http.ts (static) for v1; the
-- platforms.cors_origin column is added now so that a future migration
-- can flip the CORS middleware to read from the database without
-- another schema change. See OrangeRails-Platform-Design.md and the
-- V2-OR-INTEGRATION-PR-SPEC.md §10 follow-up notes.

-- ============================================================
-- 1. Display + CORS columns on platforms (additive only)
-- ============================================================

ALTER TABLE public.platforms
  ADD COLUMN IF NOT EXISTS display_name        TEXT,
  ADD COLUMN IF NOT EXISTS display_brand_color TEXT,
  ADD COLUMN IF NOT EXISTS cors_origin         TEXT;

COMMENT ON COLUMN public.platforms.display_name IS
  'Friendly name shown in the /connect Link widget (Plaid-hybrid pattern). Falls back to platforms.name when null.';

COMMENT ON COLUMN public.platforms.display_brand_color IS
  'CSS hex color used as the accent in the /connect Link widget header. Optional.';

COMMENT ON COLUMN public.platforms.cors_origin IS
  'Single allowed Origin for browser-direct calls (or-sync, or-transactions-list) from this platform. Static allow-list lives in _shared/http.ts for v1; this column is the future source-of-truth.';

-- Backfill display_name from name where it is null (idempotent).
UPDATE public.platforms SET display_name = name WHERE display_name IS NULL;

-- ============================================================
-- 2. Register the bitbooks-v2 platform
-- ============================================================
-- The raw API key is generated out-of-band (one-time secret hand-off
-- to V2's .env.local). Only its SHA-256 hash is stored here.
--
-- Hash below = sha256('a80b18d7cf70b5278c71436ab8052a56e4d0dcf468ed2a7b8fb0011fd358a638').
-- The raw key was returned to the V2 developer at platform-registration
-- time. Rotate by inserting a new platforms row with a new hash and
-- soft-deleting this one.

INSERT INTO public.platforms (
  slug,
  name,
  display_name,
  display_brand_color,
  cors_origin,
  api_key_hash,
  tier,
  is_internal
)
VALUES (
  'bitbooks-v2',
  'BitBooks V2',
  'BitBooks',
  '#F7931A',
  'http://localhost:3000',
  'a062878b4b05082f3f934f1879e76b9a3a21c58079ec48ed44e38035a8ce4dc3',
  'sandbox',
  false
)
ON CONFLICT (slug) DO UPDATE SET
  display_name        = EXCLUDED.display_name,
  display_brand_color = EXCLUDED.display_brand_color,
  cors_origin         = EXCLUDED.cors_origin;
