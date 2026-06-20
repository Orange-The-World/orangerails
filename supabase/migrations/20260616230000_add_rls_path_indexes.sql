-- Add indexes on RLS join paths to prevent sequential-scan DoS risk.
--
-- Closes audit findings H3 + M6 from the 2026-06-16 full review.
--
-- Background:
-- Several public tables have foreign-key columns that participate in
-- the RLS policy's join (subaccount_id -> subaccounts.id -> platforms.id ->
-- caller's platform). Without an index on the FK column, every authenticated
-- read becomes a sequential scan, and Postgres can't prune via the policy.
-- On a platform with thousands of connections / webhooks / wallets, a single
-- sync triggers full-table scans across all of them.
--
-- This migration is idempotent: every CREATE uses IF NOT EXISTS and the
-- whole thing is wrapped in IF EXISTS guards on the source tables so it
-- applies cleanly on OR DEV (which is missing some of these tables) and
-- OR PROD (which has them all). DO blocks isolate per-table failures.

-- 1. connections.subaccount_id — read on every Connections-tab load
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'connections'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_connections_subaccount
      ON public.connections(subaccount_id);
  END IF;
END $$;

-- 2. webhook_delivery.subaccount_id — read on every dequeue cycle
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'webhook_delivery'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_webhook_delivery_subaccount
      ON public.webhook_delivery(subaccount_id);
  END IF;
END $$;

-- 3. quiltt_webhook_inbox.subaccount_id — read on every or-sync (sink mode)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'quiltt_webhook_inbox'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_quiltt_webhook_inbox_subaccount
      ON public.quiltt_webhook_inbox(subaccount_id);
  END IF;
END $$;

-- 4. quiltt_profile_map.platform_id — read on every Quiltt provisioning
--    (and would full-scan on a platforms cascade-delete)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'quiltt_profile_map'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_quiltt_profile_map_platform_id
      ON public.quiltt_profile_map(platform_id);
  END IF;
END $$;

-- 5. source_wallets.subaccount_id — read on every wallet list/sync
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'source_wallets'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_source_wallets_subaccount
      ON public.source_wallets(subaccount_id);
  END IF;
END $$;

-- After this migration ships, queries that previously walked the full
-- connections / webhook_delivery / quiltt_webhook_inbox tables become
-- O(log n) index lookups. EXPLAIN ANALYZE confirms after deploy.
