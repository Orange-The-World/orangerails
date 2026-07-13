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
-- Properties of this migration:
--   Reversible: it touches privileges only, never the column, the data,
--               or a policy. The undo is a GRANT, written at the bottom.
--   Idempotent: REVOKE and GRANT are declarative. Re-running converges on
--               the same end state and never errors, never doubles.
--   Safe on an already converged database: running this where the end
--               state already holds is a no-op in effect.
--   Safe on a fresh rebuild: guarded on the table existing, so it is
--               inert if run out of order.
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
    --    is absent from this list, by design. Read only: these roles have no
    --    INSERT or UPDATE path into apps (mutation is service_role only), so
    --    write privileges are not re-granted.
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
END
$$;

COMMENT ON COLUMN public.apps.client_secret IS
  'HMAC-SHA256 signing secret for the app. Server side only: anon and authenticated hold no privilege on this column, and none may be granted. Reachable by service_role only.';

-- ============================================================
-- ROLLBACK (commented on purpose, run by hand only to undo this file)
-- ============================================================
-- This restores the pre-migration table level grants. Note what that means:
-- it puts client_secret back inside the anon and authenticated grant, which
-- is the state this migration exists to remove. Undo it only with intent.
--
--   REVOKE ALL ON TABLE public.apps FROM anon, authenticated;
--   GRANT SELECT, INSERT, UPDATE, REFERENCES ON TABLE public.apps TO anon, authenticated;
