-- ============================================================
-- platforms: column scoped grants for anon and authenticated
-- ============================================================
-- public.platforms is the integrator registry. It holds the display
-- metadata the Link widget renders (name, brand color, widget url) and,
-- in the same row, server side configuration that browser facing roles
-- have no business reading.
--
-- The general rule this file encodes:
--
--   RLS decides WHICH ROWS a role can see.
--   Grants decide WHICH COLUMNS.
--
-- A table level GRANT SELECT covers every column of the table, so a
-- permissive read policy plus a table level grant returns the whole row.
-- A policy cannot claw that back. Postgres also cannot subtract a single
-- column from a table level grant: a REVOKE SELECT (col) against a role
-- that holds the table level privilege is a no-op. The only correct
-- shape is the one below: revoke the table level grant, then re-grant
-- the exact columns that are safe to expose.
--
-- The re-granted list is the display surface and nothing else. Server
-- side callers reach the rest as service_role, which this file does not
-- touch. The assertions at the bottom pin both halves of that invariant
-- so it cannot silently regress.
--
-- Properties of this migration:
--   Reversible: it touches privileges only, never a column, the data,
--               or a policy. The undo is a GRANT, written at the bottom.
--   Idempotent: REVOKE and GRANT are declarative. Re-running converges
--               on the same end state and never errors, never doubles.
--   Guarded:    every statement is guarded on the table existing, so the
--               file is inert if it is ever run out of order.

DO $$
DECLARE
  role_name TEXT;
BEGIN
  IF to_regclass('public.platforms') IS NULL THEN
    RAISE NOTICE 'public.platforms does not exist, nothing to scope';
    RETURN;
  END IF;

  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      RAISE NOTICE 'role % does not exist, skipping', role_name;
      CONTINUE;
    END IF;

    -- 1. Clear the table level grants. A table level grant is what makes
    --    every column of the row reachable. REVOKE ALL, not REVOKE SELECT:
    --    these roles also hold INSERT, UPDATE and REFERENCES on every
    --    column from the stock defaults, and a write grant left standing
    --    stays harmless only while no permissive write policy exists.
    EXECUTE format('REVOKE ALL ON TABLE public.platforms FROM %I', role_name);

    -- 2. Re-grant SELECT on the display columns only. Read only: these
    --    roles have no INSERT or UPDATE path into platforms (mutation is
    --    service_role only), so write privileges are not re-granted.
    EXECUTE format(
      'GRANT SELECT (id, slug, name, display_name, display_brand_color, '
      'widget_url, app_profile_slug, status, env, created_at, updated_at) '
      'ON TABLE public.platforms TO %I', role_name);
  END LOOP;
END
$$;

-- ============================================================
-- Assertions: this migration proves its own end state or it fails.
-- ============================================================

DO $$
DECLARE
  role_name TEXT;
  server_col TEXT;
  server_cols TEXT[] := ARRAY[
    'webhook_secret',
    'api_key_hash',
    'quiltt_api_key',
    'quiltt_api_key_ciphertext',
    'quiltt_api_key_id'
  ];
BEGIN
  IF to_regclass('public.platforms') IS NULL THEN
    RETURN;
  END IF;

  -- Half one: the browser facing roles hold nothing on the server side
  -- columns, in any mode.
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      CONTINUE;
    END IF;

    FOREACH server_col IN ARRAY server_cols LOOP
      IF has_column_privilege(role_name, 'public.platforms', server_col, 'SELECT')
         OR has_column_privilege(role_name, 'public.platforms', server_col, 'INSERT')
         OR has_column_privilege(role_name, 'public.platforms', server_col, 'UPDATE')
      THEN
        RAISE EXCEPTION 'platforms.% must not be reachable by role %', server_col, role_name;
      END IF;
    END LOOP;

    -- And no write privilege survives anywhere on the table, on any
    -- column. has_any_column_privilege is the right probe here: it
    -- answers true for a table level privilege and for a column level
    -- one, so residue in either shape fails the migration rather than
    -- sitting loaded behind some future permissive write policy.
    IF has_any_column_privilege(role_name, 'public.platforms', 'INSERT')
       OR has_any_column_privilege(role_name, 'public.platforms', 'UPDATE')
    THEN
      RAISE EXCEPTION 'role % still holds a write privilege on platforms, mutation is service_role only', role_name;
    END IF;

    IF NOT has_column_privilege(role_name, 'public.platforms', 'slug', 'SELECT') THEN
      RAISE EXCEPTION 'role % lost SELECT on platforms.slug, the Link widget needs it', role_name;
    END IF;
  END LOOP;

  -- Half two: the server side path is intact. or-webhook-dispatch reads
  -- these two as service_role to sign and deliver outbound webhooks. If
  -- this file ever costs service_role that read, the webhook path breaks
  -- silently, so fail the migration loudly instead.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    IF NOT has_column_privilege('service_role', 'public.platforms', 'webhook_secret', 'SELECT') THEN
      RAISE EXCEPTION 'service_role can no longer read platforms.webhook_secret, outbound webhook signing would break';
    END IF;
    IF NOT has_column_privilege('service_role', 'public.platforms', 'webhook_url', 'SELECT') THEN
      RAISE EXCEPTION 'service_role can no longer read platforms.webhook_url, outbound webhook delivery would break';
    END IF;
  END IF;

  EXECUTE $comment$
    COMMENT ON COLUMN public.platforms.webhook_secret IS
      'HMAC-SHA256 signing secret for outbound webhooks to this platform. Server side only: anon and authenticated hold no privilege on this column, and none may be granted. Reachable by service_role only.'
  $comment$;

  EXECUTE $comment$
    COMMENT ON COLUMN public.platforms.quiltt_api_key IS
      'Vendor API key. Server side only: anon and authenticated hold no privilege on this column, and none may be granted. Reachable by service_role only.'
  $comment$;
END
$$;

-- ============================================================
-- ROLLBACK (commented on purpose, run by hand only to undo this file)
-- ============================================================
-- This restores the pre-migration table level grants, which is the shape
-- this migration exists to replace. Undo it only with intent.
--
--   REVOKE ALL ON TABLE public.platforms FROM anon, authenticated;
--   GRANT SELECT, INSERT, UPDATE, REFERENCES ON TABLE public.platforms TO anon, authenticated;
