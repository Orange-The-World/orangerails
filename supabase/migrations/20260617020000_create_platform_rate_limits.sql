-- Platform rate-limit counter table.
--
-- Backs the per-platform throttle in _shared/rate-limit.ts. Each row is a
-- one-minute bucket per (key, scope) pair. The scope lets us namespace
-- counters so a future limit on or-sync doesn't collide with the limit on
-- or-link-complete.
--
-- The table is small by design: rows older than one minute are useless,
-- and a sweep cron drops them. If the cron lags, the rate-limit logic
-- still works — it just queries an indexed table.
--
-- Idempotent: every CREATE uses IF NOT EXISTS so the migration re-applies
-- cleanly. The whole thing is wrapped in a DO block so OR DEV (which has
-- fewer tables provisioned) gets the same shape.

DO $$
BEGIN
  -- Skip if the schema doesn't have public.platforms — DEV doesn't, and
  -- without platforms the rate limit has no key to enforce.
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'platforms'
  ) THEN
    RAISE NOTICE 'Skipping platform_rate_limits — public.platforms not present (likely OR DEV)';
    RETURN;
  END IF;

  CREATE TABLE IF NOT EXISTS public.platform_rate_limits (
    key TEXT NOT NULL,
    scope TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key, scope, window_start)
  );

  COMMENT ON TABLE public.platform_rate_limits IS
    'Per-(key, scope) one-minute rate-limit counters. Used by _shared/rate-limit.ts to throttle public-facing OR endpoints. Key is typically a platform_id; scope is the endpoint name (e.g. ''or-link-complete'').';

  -- Index supports the hot-path query: bucket-current count by (key, scope).
  CREATE INDEX IF NOT EXISTS idx_platform_rate_limits_lookup
    ON public.platform_rate_limits(key, scope, window_start);

  -- Rows older than 5 min are useless. RLS off (service-role-only access),
  -- but enable it explicitly so any new authenticated role can't read or
  -- write counters.
  ALTER TABLE public.platform_rate_limits ENABLE ROW LEVEL SECURITY;

  -- Sweeper view: rows ready to be deleted by the cron.
  CREATE OR REPLACE VIEW public.platform_rate_limits_stale AS
  SELECT * FROM public.platform_rate_limits
  WHERE window_start < NOW() - INTERVAL '5 minutes';
END $$;

-- Atomic increment helper. Called from edge functions via
-- supabase.rpc('increment_platform_rate_limit', ...). Returns the
-- post-increment count.
CREATE OR REPLACE FUNCTION public.increment_platform_rate_limit(
  p_key TEXT,
  p_scope TEXT,
  p_window_start TIMESTAMPTZ
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_new_count INTEGER;
BEGIN
  -- Only run on projects that actually have the table; on DEV without
  -- it the function returns 0 so the caller fails open.
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'platform_rate_limits'
  ) THEN
    RETURN 0;
  END IF;

  INSERT INTO public.platform_rate_limits (key, scope, window_start, count)
  VALUES (p_key, p_scope, p_window_start, 1)
  ON CONFLICT (key, scope, window_start)
  DO UPDATE SET count = public.platform_rate_limits.count + 1
  RETURNING count INTO v_new_count;

  RETURN v_new_count;
END;
$$;

COMMENT ON FUNCTION public.increment_platform_rate_limit(TEXT, TEXT, TIMESTAMPTZ) IS
  'Atomic increment for a (key, scope, window_start) rate-limit bucket. Returns the post-increment count. Called by _shared/rate-limit.ts. SECURITY DEFINER so service-role can grant restricted execute later.';
