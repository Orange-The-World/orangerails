-- ============================================================
-- Register BitBooks and Orange Way as platforms on Orange Rails.
-- ============================================================
-- These are the first two consuming apps onboarded against the
-- platforms table. Each platform stores a hashed API key; the raw key
-- lives only in the consuming app's own secret store (set as
-- OR_PLATFORM_API_KEY on its edge functions).
--
-- ON CONFLICT (slug) DO UPDATE makes this safe to re-apply on existing
-- projects — the hash + display fields get re-synced, the row id stays
-- stable.

-- ── bitbooks-v3 ─────────────────────────────────────────────────────

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
  'bitbooks-v3',
  'BitBooks Vault (V3)',
  'BitBooks Vault',
  '#F7931A',
  'https://v3dev.bitbooks.com',
  '438756dd98e81ad7548d1e7dea14a78744b9dc95ef4086b24f43ff0ee25bcccf',
  'sandbox',
  false
)
ON CONFLICT (slug) DO UPDATE SET
  name                 = EXCLUDED.name,
  display_name         = EXCLUDED.display_name,
  display_brand_color  = EXCLUDED.display_brand_color,
  cors_origin          = EXCLUDED.cors_origin,
  api_key_hash         = EXCLUDED.api_key_hash;

-- ── orangeway ───────────────────────────────────────────────────────

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
  'orangeway',
  'Orange Way',
  'Orange Way',
  '#F7931A',
  'https://orangeway.app',
  '95e14f97ae301df43c6ee3f0d14db702a98ae17cb88e7c23e6c2fdde682f3cc7',
  'sandbox',
  false
)
ON CONFLICT (slug) DO UPDATE SET
  name                 = EXCLUDED.name,
  display_name         = EXCLUDED.display_name,
  display_brand_color  = EXCLUDED.display_brand_color,
  cors_origin          = EXCLUDED.cors_origin,
  api_key_hash         = EXCLUDED.api_key_hash;
