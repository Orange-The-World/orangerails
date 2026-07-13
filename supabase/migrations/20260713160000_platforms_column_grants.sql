-- ============================================================
-- platforms: column scoped grants for anon and authenticated
-- ============================================================
-- public.platforms is the integrator registry. Alongside the display
-- metadata the Link widget renders, it carries real credentials:
--
--   webhook_secret             HMAC key we sign outbound webhooks with
--   api_key_hash               the platform's API key hash
--   quiltt_api_key             vendor API key
--   quiltt_api_key_ciphertext  vendor API key, encrypted
--   quiltt_api_key_id          vendor key identifier
--
-- The trap this fixes is the same one already fixed on public.apps:
--   RLS decides WHICH ROWS a role can see. Grants decide WHICH COLUMNS.
--   A table level GRANT SELECT ON public.platforms covers every column,
--   so the permissive SELECT policy on this table (whose own name says
--   "metadata only") returned the entire row to the authenticated role,
--   credentials included. The policy cannot claw that back.
--
-- Postgres cannot subtract one column from a table level grant: a
-- REVOKE SELECT (webhook_secret) against a role holding the table level
-- privilege is a no-op. The only correct shape is revoke the table level
-- grant, then re-grant the exact columns that are safe.
--
-- The re-granted list is the display surface and nothing else. Every
-- credential column, every vendor config column, and the internal
-- routing columns (tier, is_internal, customer_id, cors_origin,
-- webhook_url) are absent from it by design. Server side callers reach
-- them as service_role, which this file does not touch.
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

    -- 1. Clear the table level grants. This is what was covering every
    --    column, credentials included.
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
  secret_col TEXT;
  secret_cols TEXT[] := ARRAY[
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

  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      CONTINUE;
    END IF;

    FOREACH secret_col IN ARRAY secret_cols LOOP
      IF has_column_privilege(role_name, 'public.platforms', secret_col, 'SELECT')
         OR has_column_privilege(role_name, 'public.platforms', secret_col, 'INSERT')
         OR has_column_privilege(role_name, 'public.platforms', secret_col, 'UPDATE')
      THEN
        RAISE EXCEPTION 'platforms.% is still reachable by role %', secret_col, role_name;
      END IF;
    END LOOP;

    IF NOT has_column_privilege(role_name, 'public.platforms', 'slug', 'SELECT') THEN
      RAISE EXCEPTION 'role % lost SELECT on platforms.slug, the Link widget needs it', role_name;
    END IF;
  END LOOP;

  -- or-webhook-dispatch signs outbound deliveries with this secret as
  -- service_role. If this file ever costs service_role that read, the
  -- webhook path breaks silently: fail the migration instead.
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
-- This restores the pre-migration table level grants. Note what that
-- means: it puts webhook_secret, api_key_hash, and the quiltt_* key
-- columns back inside the anon and authenticated grant, which is the
-- state this migration exists to remove. Undo it only with intent.
--
--   REVOKE ALL ON TABLE public.platforms FROM anon, authenticated;
--   GRANT SELECT, INSERT, UPDATE, REFERENCES ON TABLE public.platforms TO anon, authenticated;
