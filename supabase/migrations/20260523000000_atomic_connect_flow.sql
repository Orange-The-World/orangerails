-- Atomic connect flow (audit 2026-05-21 finding N6).
--
-- Problem: when a consumer like V2 calls or-link-complete and then fails
-- to persist its own side of the link (Save Wallet error, modal closed,
-- network blip), the OR row stays around as an orphan — the consumer
-- can never reach it again, the user gets a support ticket, and the
-- support agent has to manually delete the stale row.
--
-- Fix: introduce a pending → active state machine.
--   1. or-link-complete creates connections with status='pending' when
--      the feature flag ATOMIC_CONFIRM_REQUIRED is set on the function.
--   2. The consumer calls or-connection-confirm AFTER its own local
--      persist succeeds, flipping pending → active.
--   3. If the consumer's local persist fails, it calls
--      or-connection-cancel which deletes the pending row (and via
--      ON DELETE CASCADE, its source_wallets).
--   4. A janitor function deletes pending rows older than 10 minutes
--      so a crashed consumer can't leave orphans forever. Scheduled
--      every 5 minutes via pg_cron if available.
--
-- The feature flag preserves backward compatibility: V3 and OW haven't
-- migrated yet, so with the flag off they still get status='active'
-- immediately (current behaviour). Once all consumers ship their side
-- of the handshake we flip the flag on per consumer/environment.

-- ---------------------------------------------------------------------
-- 1. Add 'pending' as a valid status.
--
-- Defensive: the actual production schema may be either a TEXT column
-- with a CHECK constraint (per initial migration 20260419120000) or it
-- may have been upgraded to an enum type called connection_status (per
-- a DB query taken on 2026-05-21). Handle both cases without erroring
-- if the other doesn't apply.
-- ---------------------------------------------------------------------

DO $$
DECLARE
  status_typname text;
BEGIN
  -- Enum case
  SELECT typname INTO status_typname
  FROM pg_type
  WHERE typname = 'connection_status';

  IF status_typname IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_enum
      WHERE enumlabel = 'pending'
        AND enumtypid = 'public.connection_status'::regtype
    ) THEN
      EXECUTE 'ALTER TYPE public.connection_status ADD VALUE ''pending'' BEFORE ''active''';
    END IF;
  END IF;
END$$;

-- TEXT + CHECK case: rewrite the CHECK to include 'pending'.
DO $$
DECLARE
  check_name text;
BEGIN
  SELECT conname INTO check_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'connections'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%status%'
  LIMIT 1;

  IF check_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.connections DROP CONSTRAINT %I', check_name);
    EXECUTE 'ALTER TABLE public.connections '
         || 'ADD CONSTRAINT connections_status_check '
         || 'CHECK (status IN (''pending'', ''active'', ''error'', ''disconnected''))';
  END IF;
END$$;

-- ---------------------------------------------------------------------
-- 2. Helpful index for the janitor (and for or-connection-list filtering
-- out pending rows if it later chooses to).
-- ---------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_connections_status_created_at
  ON public.connections (status, created_at);

-- ---------------------------------------------------------------------
-- 3. Janitor function.
--
-- Deletes pending connections older than 10 minutes. source_wallets
-- already cascade-delete via the FK defined in 20260423000000.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cleanup_pending_connections()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count integer;
BEGIN
  WITH deleted AS (
    DELETE FROM public.connections
    WHERE status::text = 'pending'
      AND created_at < now() - interval '10 minutes'
    RETURNING id
  )
  SELECT COUNT(*) INTO deleted_count FROM deleted;

  IF deleted_count > 0 THEN
    RAISE NOTICE 'cleanup_pending_connections deleted % rows', deleted_count;
  END IF;
  RETURN deleted_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cleanup_pending_connections() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cleanup_pending_connections() FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.cleanup_pending_connections() TO service_role;

-- ---------------------------------------------------------------------
-- 4. Schedule via pg_cron if available.
--
-- pg_cron is not enabled on every Supabase project. If it isn't, this
-- migration just leaves a NOTICE — the function is still callable via
-- service-role RPC for a future edge-function-based scheduler.
-- ---------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Unschedule any previous version first so reruns are idempotent.
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname = 'cleanup_pending_connections';

    PERFORM cron.schedule(
      'cleanup_pending_connections',
      '*/5 * * * *',
      $job$SELECT public.cleanup_pending_connections();$job$
    );
    RAISE NOTICE 'cleanup_pending_connections scheduled every 5 minutes via pg_cron';
  ELSE
    RAISE NOTICE 'pg_cron not enabled; cleanup_pending_connections must be triggered manually or via an edge-function scheduler';
  END IF;
END$$;
