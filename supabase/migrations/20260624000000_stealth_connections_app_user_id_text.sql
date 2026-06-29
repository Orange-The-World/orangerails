-- Stealth Sync: relax app_user_id from UUID to TEXT.
--
-- Consumer apps integrating Stealth Sync use heterogeneous user/org ID
-- formats: some use Prisma CUIDs, Supabase-Auth apps use UUIDs, third-party
-- platforms may use any opaque format (ULIDs, KSUIDs, plain strings).
-- Pinning the column to UUID forces every caller's ID through a uuid cast,
-- which fails for non-UUID formats and surfaces as a generic 500 from
-- or-stealth-connection-create when the dedup lookup
-- .eq('app_user_id', body.app_user_id) tries the implicit cast.
--
-- TEXT is the right contract: app_user_id is a consumer-provided opaque
-- identifier, never minted or interpreted by OR. The existing RLS policy
-- (auth.uid()::text = app_user_id::text) already casts both sides to text,
-- so the change is policy-neutral. Indexes on the column rebuild
-- automatically under ALTER COLUMN TYPE. The sibling table
-- pending_widget_sessions.app_user_id is already TEXT, so this aligns
-- the two stealth tables.
--
-- Existing rows: any prior UUID values cast cleanly to text via USING.
--
-- PostgreSQL blocks ALTER COLUMN TYPE when any policy depends on the column,
-- including policies on other tables whose USING clause references it via JOIN.
-- The stealth_transactions read policy joins to stealth_connections.app_user_id,
-- so both policies must be dropped before the ALTER and recreated after.

DROP POLICY IF EXISTS "Owners can read their stealth connections" ON public.stealth_connections;
DROP POLICY IF EXISTS "Owners can read their stealth transactions" ON public.stealth_transactions;

ALTER TABLE public.stealth_connections
  ALTER COLUMN app_user_id TYPE TEXT USING app_user_id::text;

CREATE POLICY "Owners can read their stealth connections"
  ON public.stealth_connections
  FOR SELECT
  USING (auth.uid()::text = app_user_id::text);

CREATE POLICY "Owners can read their stealth transactions"
  ON public.stealth_transactions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.stealth_connections sc
      WHERE sc.id = stealth_transactions.connection_id
        AND auth.uid()::text = sc.app_user_id::text
    )
  );

COMMENT ON COLUMN public.stealth_connections.app_user_id IS
  'Consumer-app user/org identifier. Opaque to OR. Format is whatever the calling platform uses (CUID, UUID, ULID, ...). Scoped by (platform_id, app_user_id).';
