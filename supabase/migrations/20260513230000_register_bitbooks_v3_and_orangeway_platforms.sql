-- ============================================================
-- Register bitbooks-v3 (V3 / BitBooks Vault) + orangeway (Orange Way)
-- platforms on OR.
-- ============================================================
-- Both raw keys were generated 2026-05-13:
--   - bitbooks-v3 raw key was previously minted on the old Lovable Cloud
--     OR project (tbjffcasjkhhlmsqnjim) and carried over to the new
--     orangerails-prod (lcdicqalreskibdfxkzb) without rotation. Lives in
--     V3's edge function secret OR_PLATFORM_API_KEY on
--     pfoywzsziessalioerlg (V3 dev) and bitbooks-vault-prod (V3 prod
--     when wired).
--   - orangeway raw key was freshly generated 2026-05-13 and persisted
--     in /opt/bb-support/.env.sops as OW_OR_PLATFORM_API_KEY. Set on OW
--     edge fns OR_PLATFORM_API_KEY at both orangeway-dev
--     (bogmoovbjpvcvdqrmjgt) and orangeway-prod (mggalsdproqwmtwwtinm).
--
-- ON CONFLICT (slug) DO UPDATE makes this safe to re-apply on existing
-- projects — the hash + display fields get re-synced, the row id stays
-- stable.
--
-- Rotation procedure: see
-- https://wiki.bitbooks.com/<runbook-doc-id>

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
