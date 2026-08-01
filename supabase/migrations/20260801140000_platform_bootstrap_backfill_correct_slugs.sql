-- Corrective backfill for the platform bootstrap columns.
--
-- 20260620180000_platform_bootstrap_columns.sql backfilled widget_url and
-- app_profile_slug with a WHERE slug IN ('bbv2', 'bbv3', 'owm', 'owb',
-- 'direct') clause. Four of those five slugs do not exist in
-- public.platforms (the real slugs are bitbooks-v2, bitbooks-v3,
-- orangeway-me, orangeway-books, and so on), so only the 'direct' row was
-- updated. Every other platform kept widget_url and app_profile_slug NULL,
-- which leaves the bootstrap response incomplete for those platforms.
--
-- This migration corrects app_profile_slug only. It sets app_profile_slug to
-- the row's own slug wherever it is NULL, which matches the onboarding
-- helper default (COALESCE(p_app_profile_slug, p_slug)), and it matches on
-- the NULL state rather than a hardcoded slug list so it cannot silently
-- skip a row.
--
-- widget_url is deliberately left NULL on the rows the original missed.
-- supabase/functions/or-platform-bootstrap/index.ts already returns
-- row.widget_url ?? 'https://connect.orangerails.com', so NULL and the
-- default are the same answer at read time. Writing the default into the
-- table buys no behaviour and would turn a visible gap into a permanent
-- wrong value for any platform that hosts its widget elsewhere.
--
-- Idempotent: only rows where app_profile_slug IS NULL are touched, so a
-- re-run is a no-op. No undo block: the corrected app_profile_slug equals
-- the row's own slug and is derivable at any time, and reverting it back to
-- NULL would re-break the bootstrap response.

UPDATE public.platforms
SET app_profile_slug = slug
WHERE app_profile_slug IS NULL;
