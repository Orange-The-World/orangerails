-- Give service_role the explicit privileges hosted Supabase already grants it implicitly.
--
-- Hosted Supabase provisions a platform level bootstrap grant, outside supabase/migrations,
-- that hands postgres, anon, authenticated and service_role privileges on every table at
-- creation time. A fresh local or CI stack booted purely by replaying supabase/migrations
-- does not get that bootstrap grant. Any table whose migration never explicitly grants
-- service_role something therefore ends up with zero service_role privileges locally, even
-- though the same table works fine on hosted dev and prod.
--
-- OR-T1955 step 7 hit this first: 20260713120001_apps_client_secret_column_grants.sql
-- REVOKEs ALL on public.apps from anon/authenticated and re-grants safe columns, but its
-- own end of file assertion requires service_role to still SELECT client_secret. That
-- assertion fails on a fresh local/CI stack because the file never grants service_role
-- anything, by design (hosted already had it). That file is already applied on hosted and
-- cannot be edited, so this is a new migration.
--
-- Auditing every other migration for the same implicit grant assumption (OR-T1955 step 7)
-- found two more tables that would fail the exact same way, in filename order, immediately
-- after apps: platforms (20260713160000_platforms_column_grants.sql) and
-- discovery_sessions (20260716120000_discovery_sessions.sql). Both are fixed here.
--
-- public.connections carries the identical gap for UPDATE (20260902230000) and INSERT
-- (20260902234500), but it is the oldest, largest and most sensitive table in this project
-- (core financial connection data) and its full required service_role privilege set has not
-- been verified end to end. It is deliberately left out of this migration and tracked as an
-- open follow up on OR-T1955, rather than guessed at with a blanket grant.
--
-- This migration is a no-op on hosted dev and prod: service_role already has every one of
-- these privileges there through the implicit bootstrap grant. It only changes behavior on
-- a fresh local or CI stack built solely from these migration files.
--
-- Reversible: yes, see the commented rollback at the bottom.
-- Idempotent: yes, GRANT is safe to repeat and every block is guarded by to_regclass.
-- Guarded: yes, each grant only runs if the target table and the service_role role exist.
-- Safe on fresh rebuild: yes, this is the exact case it fixes.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise notice 'service_role does not exist on this database, skipping all grants in this migration';
    return;
  end if;

  if to_regclass('public.apps') is not null then
    grant select (client_secret, id, slug, name, description, redirect_uri_pattern, created_at, updated_at)
      on table public.apps to service_role;
  else
    raise notice 'public.apps does not exist, skipping its service_role grant';
  end if;

  if to_regclass('public.platforms') is not null then
    grant all on table public.platforms to service_role;
  else
    raise notice 'public.platforms does not exist, skipping its service_role grant';
  end if;

  if to_regclass('public.discovery_sessions') is not null then
    grant select, insert, delete on table public.discovery_sessions to service_role;
  else
    raise notice 'public.discovery_sessions does not exist, skipping its service_role grant';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    return;
  end if;

  if to_regclass('public.apps') is not null and not has_column_privilege('service_role', 'public.apps', 'client_secret', 'SELECT') then
    raise exception 'assert failed: service_role cannot SELECT public.apps.client_secret after this migration';
  end if;

  if to_regclass('public.platforms') is not null then
    if not has_column_privilege('service_role', 'public.platforms', 'webhook_secret', 'SELECT') then
      raise exception 'assert failed: service_role cannot SELECT public.platforms.webhook_secret after this migration';
    end if;
    if not has_column_privilege('service_role', 'public.platforms', 'webhook_url', 'SELECT') then
      raise exception 'assert failed: service_role cannot SELECT public.platforms.webhook_url after this migration';
    end if;
  end if;

  if to_regclass('public.discovery_sessions') is not null then
    if not has_table_privilege('service_role', 'public.discovery_sessions', 'SELECT') then
      raise exception 'assert failed: service_role cannot SELECT public.discovery_sessions after this migration';
    end if;
    if not has_table_privilege('service_role', 'public.discovery_sessions', 'INSERT') then
      raise exception 'assert failed: service_role cannot INSERT into public.discovery_sessions after this migration';
    end if;
    if not has_table_privilege('service_role', 'public.discovery_sessions', 'DELETE') then
      raise exception 'assert failed: service_role cannot DELETE from public.discovery_sessions after this migration';
    end if;
  end if;
end $$;

-- Rollback (manual only, never run automatically):
-- revoke select (client_secret, id, slug, name, description, redirect_uri_pattern, created_at, updated_at)
--   on table public.apps from service_role;
-- revoke all on table public.platforms from service_role;
-- revoke select, insert, delete on table public.discovery_sessions from service_role;
