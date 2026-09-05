-- ============================================================
-- Converge the state that duplicate migration version 20260713120000 can skip
-- ============================================================
-- THE BUG THIS EXISTS FOR
--
-- Two files in this directory carry the same version key, 20260713120000:
--
--   20260713120000_apps_client_secret_column_grants.sql   <- the #121 security fix
--   20260713120000_customers_analytics_id.sql
--
-- supabase_migrations.schema_migrations keys applied migrations by VERSION, and
-- version is one row. Two files, one key. On a fresh rebuild, a new environment,
-- or a dev -> prod promotion, the CLI applies one of these files, records
-- 20260713120000 as applied, and then considers the other one already done. It
-- is skipped. Silently, with a green run.
--
-- If the file that gets skipped is the grants file, then:
--   REVOKE ALL ON public.apps FROM anon, authenticated  never runs,
-- and apps.client_secret sits back inside the table-level grant, readable by
-- any browser role. That is the exact exposure #121 was opened to close.
--
-- We should not be betting a CRITICAL fix on a filename tie-break. This file
-- does not depend on which one wins: it re-applies BOTH end states at a later,
-- unique version, and then proves the security end state or fails the migration.
--
-- PROPERTIES
--   Idempotent: every statement converges. Re-running changes nothing.
--   Inert where already correct: on a database that applied both files, this is
--     a no-op in effect. It is not a rollback of anything.
--   Guarded: every block checks the relation and the role exist first, so it is
--     safe on a partially built database and safe out of order.
--   Reversible: privileges and one nullable-with-default column. Undo at the foot.
--
-- THIS DOES NOT FIX THE COLLISION ITSELF. Two files still share one version key,
-- and that is a landmine for the next person who adds a migration near it. The
-- real cleanup is to rename one of them to a unique version, which needs a file
-- delete that the agent GitHub tooling cannot do. Tracked separately. This file
-- removes the SECURITY consequence of the collision, not the collision.
-- ============================================================


-- ------------------------------------------------------------
-- 1. apps: re-assert the column-scoped grants (from the #121 file)
-- ------------------------------------------------------------
-- RLS decides WHICH ROWS a role sees. Grants decide WHICH COLUMNS. A table-level
-- GRANT SELECT covers every column, so a permissive read policy plus a table-level
-- grant hands back the whole row, client_secret included, and no policy can claw
-- that back. Postgres cannot subtract a single column from a table-level grant:
-- the only correct shape is revoke the table grant, then re-grant the safe columns.
--
-- service_role is deliberately untouched: the server-side token exchange runs as
-- service_role and must keep reading client_secret.

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

    EXECUTE format('REVOKE ALL ON TABLE public.apps FROM %I', role_name);

    EXECUTE format(
      'GRANT SELECT (id, slug, name, description, redirect_uri_pattern, created_at, updated_at) '
      'ON TABLE public.apps TO %I', role_name);
  END LOOP;

  EXECUTE $comment$
    COMMENT ON COLUMN public.apps.client_secret IS
      'HMAC-SHA256 signing secret for the app. Server side only: anon and authenticated hold no privilege on this column, and none may be granted. Reachable by service_role only.'
  $comment$;
END
$$;


-- ------------------------------------------------------------
-- 2. customers.analytics_id: re-assert the column (from the other 20260713120000 file)
-- ------------------------------------------------------------
-- Same guards as the original file, so this is a no-op wherever that file did run.
-- An opaque per-customer pseudonym for analytics. Random, not derived from any
-- other column, never a foreign key, so it can leave the system and can be rotated
-- with a single UPDATE.
--
-- Volume note, carried forward from the original file: a NOT NULL column with a
-- volatile default rewrites the table on apply. public.customers was empty when
-- that was written. If customers ever carries real volume, this block must be
-- split into add-nullable, backfill in batches, then SET NOT NULL. It is guarded
-- on IF NOT EXISTS, so on any database that already has the column it does nothing
-- at all and the rewrite never happens.

DO $$
BEGIN
  IF to_regclass('public.customers') IS NULL THEN
    RAISE NOTICE 'public.customers does not exist, nothing to add';
    RETURN;
  END IF;

  ALTER TABLE public.customers
    ADD COLUMN IF NOT EXISTS analytics_id uuid NOT NULL DEFAULT gen_random_uuid();

  CREATE UNIQUE INDEX IF NOT EXISTS customers_analytics_id_key
    ON public.customers (analytics_id);

  EXECUTE $comment$
    COMMENT ON COLUMN public.customers.analytics_id IS
      'Opaque per customer pseudonym for product analytics. Never a foreign key, never joined on, never derived from customers.id. Safe to send to a third party analytics tool, and safe to rotate on request with a single UPDATE. Do not replace with customers.id: a join key that leaves the system cannot be recalled.'
  $comment$;
END
$$;


-- ============================================================
-- 3. Assertions: this migration proves the security end state or it fails.
-- ============================================================
-- The whole point of the file. A convergence migration that quietly did nothing
-- would be worse than no migration at all, because the green run would be read as
-- proof. So: hard-fail if client_secret is reachable by a browser role, hard-fail
-- if service_role lost it, hard-fail if the widget lost the column it renders from.

DO $$
DECLARE
  role_name TEXT;
BEGIN
  IF to_regclass('public.apps') IS NOT NULL THEN
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
  END IF;

  IF to_regclass('public.customers') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'customers'
         AND column_name = 'analytics_id')
  THEN
    RAISE EXCEPTION 'customers.analytics_id is missing after convergence';
  END IF;
END
$$;


-- ============================================================
-- ROLLBACK (commented on purpose, run by hand only to undo this file)
-- ============================================================
-- Undoing the grants block puts client_secret BACK inside the anon and
-- authenticated table grant, which is the exposure this file exists to keep
-- closed. Undo it only with intent.
--
--   REVOKE ALL ON TABLE public.apps FROM anon, authenticated;
--   GRANT SELECT, INSERT, UPDATE, REFERENCES ON TABLE public.apps TO anon, authenticated;
--
--   DROP INDEX IF EXISTS public.customers_analytics_id_key;
--   ALTER TABLE public.customers DROP COLUMN IF EXISTS analytics_id;
