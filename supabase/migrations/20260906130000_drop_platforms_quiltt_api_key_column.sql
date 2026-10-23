-- Drop platforms.quiltt_api_key: recreate v_platform_quiltt_config without it
-- first (a view dependency), then drop the column.
--
-- Ruled on OR-T1454/OR-T1527 (CTO): bitbooks-v2 is the only one of eight
-- platforms with this column populated; the other seven already run on the
-- QUILTT_API_KEY function env var via the ?? fallback in
-- supabase/functions/_shared/quiltt-config.ts. The paired code PR (OR-T2565)
-- stops that function from selecting this column by name at all, so it is
-- safe to drop here without breaking any PostgREST select.
--
-- v_platform_quiltt_config selects this column directly (created in
-- 20260610150000, hardened in 20260713180000 with REVOKE ALL FROM anon,
-- authenticated and security_invoker=true). CREATE OR REPLACE VIEW cannot
-- drop a column, so this uses DROP VIEW then CREATE VIEW, and restores both
-- hardening statements plus the view's comment, none of which a freshly
-- created view inherits (flagged by the Auditor on OR-T2137).
--
-- Guarded on live state, not on the counts measured when this was written:
-- refuses if quiltt_api_key is populated in any row at apply time, so a
-- cluster whose data has moved since 2026-09 does not silently lose a value.
--
-- Rollback: re-add the column (ALTER TABLE public.platforms ADD COLUMN
-- quiltt_api_key text), then DROP and CREATE the view again including it.
-- The guard below proves the column carried no data at the instant it was
-- dropped, so on this cluster there is nothing to restore into it; on a
-- cluster where the guard fires, this migration never ran, so there is
-- nothing to roll back.
--
-- This is a dev-only apply. The prod DROP is irreversible (real credential
-- value, no restore path once dropped) and needs the founder's go plus a
-- separate prod-apply ticket, per OR-T2565's required order.

do $$
declare
  v_populated int;
begin
  -- Take the same lock the DROP will take, first, so the count below and
  -- the DROP describe the same instant.
  lock table public.platforms in access exclusive mode;

  select count(*)
    into v_populated
    from public.platforms
   where quiltt_api_key is not null;

  if v_populated <> 0 then
    raise exception 'drop_platforms_quiltt_api_key_column FAILED: platforms.quiltt_api_key is populated in % row(s) on this cluster; refusing to drop a column that appears to be in use. Backfill the value into the QUILTT_API_KEY function env var and re-verify before re-running this file.', v_populated;
  end if;

  raise notice 'drop_platforms_quiltt_api_key_column: confirmed 0 populated rows, proceeding.';
end $$;

drop view if exists public.v_platform_quiltt_config;

create view public.v_platform_quiltt_config as
select
  id as platform_id,
  slug,
  tier,
  sink_format,
  quiltt_api_key_id,
  quiltt_connector_id_link,
  quiltt_connector_id_reconnect,
  quiltt_catalog_profile_id
from public.platforms;

revoke all on table public.v_platform_quiltt_config from anon, authenticated;
alter view public.v_platform_quiltt_config set (security_invoker = true);

comment on view public.v_platform_quiltt_config is
  'Convenience view of per-platform Quiltt config plus sink format. Service-role only, never expose to anon or authenticated. Edge functions read this with the service-role client to avoid serializing 4 separate columns each call.';

alter table public.platforms
  drop column if exists quiltt_api_key;

-- Guard, after the drop. Assert the END STATE: the column must actually be
-- gone, and the recreated view must still resolve with no error.
do $$
begin
  if exists (
       select 1
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'platforms'
          and column_name = 'quiltt_api_key'
     ) then
    raise exception 'drop_platforms_quiltt_api_key_column FAILED: platforms.quiltt_api_key still exists after the drop statement.';
  end if;

  perform 1 from public.v_platform_quiltt_config limit 1;

  raise notice 'drop_platforms_quiltt_api_key_column: end state verified, column is gone and the view still resolves.';
end $$;
