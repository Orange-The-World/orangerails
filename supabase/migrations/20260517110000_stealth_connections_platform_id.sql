-- Audit 2026-05-16 High #2 — bind stealth_connections to the calling platform.
--
-- Previously: stealth_connections.app_slug was a caller-supplied text field
-- used as a "defense-in-depth filter." That meant Platform A's API key with
-- a stolen (connection_id, app_user_id) pair could read, overwrite, or
-- delete Platform B's connections. Sealed envelope content stays
-- recipient-encrypted, so disclosure was mitigated, but write/delete caused
-- integrity loss and a DoS vector.
--
-- This migration adds a real platform_id foreign key, backfills it from
-- app_slug (currently zero rows in both dev and prod, verified), and adds
-- the supporting index. Edge functions are updated in the same PR to bind
-- queries to ctx.platformId (platform mode) or the 'direct' platform (direct
-- mode).

-- 1) Add platform_id column. Nullable initially so backfill can run.
ALTER TABLE public.stealth_connections
  ADD COLUMN IF NOT EXISTS platform_id UUID REFERENCES public.platforms(id) ON DELETE CASCADE;

-- 2) Backfill: map app_slug -> platforms.slug -> platforms.id where possible.
--    Currently zero rows in dev and prod; this is template-correct for any
--    future re-application.
UPDATE public.stealth_connections sc
SET platform_id = p.id
FROM public.platforms p
WHERE sc.platform_id IS NULL AND sc.app_slug = p.slug;

-- 3) Abort if any rows still have NULL platform_id. Forces a manual look at
--    historical data before tightening the constraint.
DO $$
DECLARE missing INTEGER;
BEGIN
  SELECT COUNT(*) INTO missing FROM public.stealth_connections WHERE platform_id IS NULL;
  IF missing > 0 THEN
    RAISE EXCEPTION 'Cannot make stealth_connections.platform_id NOT NULL: % rows have no matching platform.slug. Map them manually before re-applying.', missing;
  END IF;
END $$;

-- 4) Now NOT NULL.
ALTER TABLE public.stealth_connections
  ALTER COLUMN platform_id SET NOT NULL;

-- 5) Index on platform_id for RLS / edge-function query plans.
CREATE INDEX IF NOT EXISTS stealth_connections_platform_idx
  ON public.stealth_connections (platform_id);

COMMENT ON COLUMN public.stealth_connections.platform_id IS
  'The platform that owns this connection. Populated from ctx.platformId on insert (platform mode) or from the "direct" platform (direct mode). Used by edge functions to bind every read/write to the calling platform. See audit 2026-05-16 finding #2.';
