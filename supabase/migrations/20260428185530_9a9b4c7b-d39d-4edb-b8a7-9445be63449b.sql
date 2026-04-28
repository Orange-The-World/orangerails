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

UPDATE public.platforms SET display_name = name WHERE display_name IS NULL;

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