-- 20260616120000_quiltt_connection_id.sql
--
-- Add per-link Quiltt connection ID to `connections` so a single subaccount
-- can host multiple Quiltt-backed banks. The prior schema assumed
-- (subaccount_id, provider_type='quiltt') was unique, which silently
-- collapsed multiple banks (e.g. Mercury + TD) into one row, last-write-wins.
--
-- Nullable on purpose:
--   * pre-existing rows have no Quiltt connection id captured (they were
--     created before this column existed). They keep working as the
--     "default" Quiltt connection for the subaccount until the user relinks.
--   * non-Quiltt provider rows leave the column NULL.
--
-- The partial unique index enforces uniqueness only for Quiltt rows that
-- DO carry a connection id, so a relink with the same Quiltt connectionId
-- updates the existing row instead of creating a duplicate.
--
-- Wrapped in a DO block guarded on table existence: the OR DEV Supabase
-- project (gposxxmxenrdvewrprle) is provisioned bare without the hub
-- foundation migrations applied, so this would otherwise fail CI. PROD
-- has the table and the column will land normally.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'connections'
  ) THEN
    ALTER TABLE public.connections
      ADD COLUMN IF NOT EXISTS quiltt_connection_id TEXT;

    CREATE UNIQUE INDEX IF NOT EXISTS connections_subaccount_quiltt_conn_uniq
      ON public.connections (subaccount_id, quiltt_connection_id)
      WHERE provider_type = 'quiltt' AND quiltt_connection_id IS NOT NULL;

    COMMENT ON COLUMN public.connections.quiltt_connection_id IS
      'Quiltt''s connectionId from onExitSuccess. One row per linked Quiltt connection. NULL on legacy rows and on non-Quiltt providers.';
  ELSE
    RAISE NOTICE 'public.connections does not exist on this project — skipping quiltt_connection_id migration (hub foundation not applied here).';
  END IF;
END
$$;
