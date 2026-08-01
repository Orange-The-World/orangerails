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
-- The original intent was:
--   widget_url       = COALESCE(widget_url, 'https://connect.orangerails.com')
--   app_profile_slug = COALESCE(app_profile_slug, slug)
-- so each platform's app_profile_slug defaults to its own slug and every
-- platform points at the shared connect widget. This migration completes
-- that backfill for the rows the original missed, matching on the NULL
-- state rather than a hardcoded slug list so it cannot silently skip a row.
--
-- Idempotent: only rows where a target column IS NULL are touched, so a
-- re-run is a no-op. No undo block: the corrected app_profile_slug equals
-- the row's own slug and is derivable at any time, and reverting either
-- column back to NULL would re-break the bootstrap response.

UPDATE public.platforms
SET app_profile_slug = COALESCE(app_profile_slug, slug),
    widget_url       = COALESCE(widget_url, 'https://connect.orangerails.com')
WHERE app_profile_slug IS NULL
   OR widget_url IS NULL;
