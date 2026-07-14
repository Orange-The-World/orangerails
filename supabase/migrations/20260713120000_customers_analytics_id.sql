-- ============================================================
-- DEPRECATED FILE. Kept only because its version key collides.
-- ============================================================
-- This file and 20260713120000_apps_client_secret_column_grants.sql carry the
-- SAME version key, 20260713120000. supabase_migrations.schema_migrations keys
-- an applied migration by version, and a version is one row, so on a fresh
-- build, a new environment, or a dev to prod promotion the CLI can apply one of
-- the two, record 20260713120000 as done, and skip the other. Which one wins is
-- a filename tie-break.
--
-- That is not a thing the apps.client_secret fix should depend on. So this file
-- now carries the SAME statements as its twin: whichever file the CLI picks, the
-- column scoped grants on public.apps are applied and the tie-break stops
-- mattering. Every statement is guarded and idempotent, so running one, the
-- other, or both converges on one end state.
--
-- The customers.analytics_id column that used to live here is NOT lost. It ships
-- at its own unique version, 20260713140000_customers_analytics_id.sql, which is
-- the copy the dev database actually recorded.
--
-- The real cleanup is renaming this file to a unique version, which needs a file
-- delete. Until an operator does that, this file must stay a copy of its twin.
-- If you edit one of the two, edit both.
-- ============================================================

-- ============================================================
-- apps.client_secret: column scoped grants for anon and authenticated
-- ============================================================
-- public.apps carries client_secret, the HMAC signing secret for a
-- registered app. It is a server side value. The browser facing roles
-- (anon, authenticated) need the public metadata columns so the Link
-- widget can render "App X is requesting access", and nothing else.
--
-- The trap this fixes:
--   RLS decides WHICH ROWS a role can see. Grants decide WHICH COLUMNS.
--   A table level GRANT SELECT ON public.apps covers every column of the
--   table, so a permissive SELECT policy plus a table level grant returns
--   the whole row, client_secret included. A policy cannot claw that back.
--
-- Postgres cannot subtract one column from a table level grant: a
-- REVOKE SELECT (client_secret) against a role that holds the table level
-- privilege is a no-op. The only correct shape is revoke the table level
-- grant, then re-grant the exact columns that are safe.
--
-- service_role is deliberately untouched. The token exchange runs server
-- side as service_role and must keep reading client_secret. The final
-- assertion in this file fails the migration loudly if that ever stops
-- being true, rather than shipping a quietly broken auth path.

DO $$
DECLARE
  role_name TEXT;
BEGIN
  IF to_regclass('public.apps') IS NULL THEN
    RAISE NOTICE 'public.apps does not exist, nothing to scope';
    RETURN;
  END IF;

  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      RAISE NOTICE 'role % does not exist, skipping', role_name;
      CONTINUE;
    END IF;

    -- 1. Clear the table level grants. This is what was covering every column.
    EXECUTE format('REVOKE ALL ON TABLE public.apps FROM %I', role_name);

    -- 2. Re-grant SELECT on the public metadata columns only. client_secret
    --    is absent from this list, by design.
    EXECUTE format(
      'GRANT SELECT (id, slug, name, description, redirect_uri_pattern, created_at, updated_at) '
      'ON TABLE public.apps TO %I', role_name);
  END LOOP;
END
$$;

-- ============================================================
-- Assertions: this migration proves its own end state or it fails.
-- ============================================================

DO $$
DECLARE
  role_name TEXT;
BEGIN
  IF to_regclass('public.apps') IS NULL THEN
    RETURN;
  END IF;

  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      CONTINUE;
    END IF;

    IF has_column_privilege(role_name, 'public.apps', 'client_secret', 'SELECT')
       OR has_column_privilege(role_name, 'public.apps', 'client_secret', 'INSERT')
       OR has_column_privilege(role_name, 'public.apps', 'client_secret', 'UPDATE')
    THEN
      RAISE EXCEPTION 'apps.client_secret is still reachable by role %', role_name;
    END IF;

    IF NOT has_column_privilege(role_name, 'public.apps', 'slug', 'SELECT') THEN
      RAISE EXCEPTION 'role % lost SELECT on apps.slug, the Link widget needs it', role_name;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
     AND NOT has_column_privilege('service_role', 'public.apps', 'client_secret', 'SELECT')
  THEN
    RAISE EXCEPTION 'service_role can no longer read apps.client_secret, the server side token exchange would break';
  END IF;

  EXECUTE $comment$
    COMMENT ON COLUMN public.apps.client_secret IS
      'HMAC-SHA256 signing secret for the app. Server side only: anon and authenticated hold no privilege on this column, and none may be granted. Reachable by service_role only.'
  $comment$;
END
$$;

-- ============================================================
-- ROLLBACK (commented on purpose, run by hand only to undo this file)
-- ============================================================
-- This restores the pre-migration table level grants. Note what that means:
-- it puts client_secret back inside the anon and authenticated grant, which
-- is the state this migration exists to remove. Undo it only with intent.
--
--   REVOKE ALL ON TABLE public.apps FROM anon, authenticated;
--   GRANT SELECT, INSERT, UPDATE, REFERENCES ON TABLE public.apps TO anon, authenticated;
