-- ============================================================
-- Register orangeway-me (OWM) + orangeway-books (OWB) platforms on OR.
-- ============================================================
-- The raw API keys are held by the Orange Way maintainers and set as
-- OR_PLATFORM_API_KEY on each app's own edge function secrets. Until
-- OWB has a live tenant project provisioned it remains a paper platform
-- (DB row exists, no live tenant calls).
--
-- The legacy `orangeway` row registered earlier is kept untouched as a
-- backward-compatibility alias. Once consumers have migrated to the new
-- key, a follow-up migration retires it.
--
-- ON CONFLICT (slug) DO UPDATE makes this idempotent.

-- ── orangeway-me (Orange Way Personal / family) ──────────────────────

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
  'orangeway-me',
  'Orange Way Personal (OWM)',
  'Orange Way Personal',
  '#F7931A',
  'https://orangeway.app',
  'c1cf1b009dc8c31ef24614eaf5123233488e082047cd1cd50ffc85ce5af1d025',
  'sandbox',
  false
)
ON CONFLICT (slug) DO UPDATE SET
  name                 = EXCLUDED.name,
  display_name         = EXCLUDED.display_name,
  display_brand_color  = EXCLUDED.display_brand_color,
  cors_origin          = EXCLUDED.cors_origin,
  api_key_hash         = EXCLUDED.api_key_hash;

-- ── orangeway-books (Orange Way Books — commercial bookkeeping) ──────

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
  'orangeway-books',
  'Orange Way Books (OWB)',
  'Orange Way Books',
  '#F7931A',
  'https://books.orangeway.app',
  'deeb1ac755562952457a493e0bc3bbc1fc4feffe82657411ec0e51c3bfe46057',
  'sandbox',
  false
)
ON CONFLICT (slug) DO UPDATE SET
  name                 = EXCLUDED.name,
  display_name         = EXCLUDED.display_name,
  display_brand_color  = EXCLUDED.display_brand_color,
  cors_origin          = EXCLUDED.cors_origin,
  api_key_hash         = EXCLUDED.api_key_hash;
