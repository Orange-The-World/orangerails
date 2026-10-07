-- Revoke the unpoliced anon table level SELECT grants on RLS enabled tables
-- in schema public (OR-T1421, out of the adjudication on OR-T1409 and the
-- definition settled on OR-T1548).
--
-- MEASURED ON DEV (fzwmnzmtqidumdqjdddz) BEFORE WRITING THIS FILE, 2026-09-02:
--   31 RLS enabled tables in public grant table level SELECT to anon.
--   22 of them have no policy admitting anon for SELECT.  Those 22 are below.
--    9 of them do have such a policy and are deliberately untouched.
--   anon holds column level SELECT on only two tables, apps and platforms,
--   neither of which is in the 22, so no table level REVOKE here can clear a
--   column level grant.  That trap is real (it is what a table wide REVOKE did
--   to user_vault_meta) and it does not fire on this axis.
--   anon holds exactly two non SELECT privileges anywhere in public: INSERT on
--   adapter_requests and INSERT on waitlist.  Both are load bearing for the
--   unauthenticated public forms and both must survive this file.
--
-- CLIENT SURFACE: no client path reads any of the 22 while unauthenticated.
-- The four read sites either return early with no user, or call getSession()
-- and redirect to the login route before they query.
--
-- REVERSIBLE: yes.  To undo, re-grant:
--   GRANT SELECT ON TABLE public.adapter_requests        TO anon;
--   GRANT SELECT ON TABLE public.agent_invitation_tokens TO anon;
--   GRANT SELECT ON TABLE public.agent_members           TO anon;
--   GRANT SELECT ON TABLE public.audit_entries           TO anon;
--   GRANT SELECT ON TABLE public.audit_events            TO anon;
--   GRANT SELECT ON TABLE public.channel_state           TO anon;
--   GRANT SELECT ON TABLE public.customers               TO anon;
--   GRANT SELECT ON TABLE public.data_keys               TO anon;
--   GRANT SELECT ON TABLE public.encrypted_transactions  TO anon;
--   GRANT SELECT ON TABLE public.invoices                TO anon;
--   GRANT SELECT ON TABLE public.payments                TO anon;
--   GRANT SELECT ON TABLE public.pending_widget_sessions TO anon;
--   GRANT SELECT ON TABLE public.quiltt_profile_map      TO anon;
--   GRANT SELECT ON TABLE public.quiltt_webhook_inbox    TO anon;
--   GRANT SELECT ON TABLE public.source_wallets          TO anon;
--   GRANT SELECT ON TABLE public.staff_users             TO anon;
--   GRANT SELECT ON TABLE public.strike_webhook_events   TO anon;
--   GRANT SELECT ON TABLE public.subaccounts             TO anon;
--   GRANT SELECT ON TABLE public.subscriptions           TO anon;
--   GRANT SELECT ON TABLE public.user_app_grants         TO anon;
--   GRANT SELECT ON TABLE public.waitlist                TO anon;
--   GRANT SELECT ON TABLE public.webhook_delivery        TO anon;
--
-- IDEMPOTENT: REVOKE on a privilege that is already absent is a no op, so this
-- file is safe to re-run.  The assertion block uses catalog queries computed
-- at apply time rather than a hard-coded expected list, so it passes on both
-- dev and prod regardless of which reference tables exist in each environment.

REVOKE SELECT ON TABLE public.adapter_requests        FROM anon;
REVOKE SELECT ON TABLE public.agent_invitation_tokens FROM anon;
REVOKE SELECT ON TABLE public.agent_members           FROM anon;
REVOKE SELECT ON TABLE public.audit_entries           FROM anon;
REVOKE SELECT ON TABLE public.audit_events            FROM anon;
REVOKE SELECT ON TABLE public.channel_state           FROM anon;
REVOKE SELECT ON TABLE public.customers               FROM anon;
REVOKE SELECT ON TABLE public.data_keys               FROM anon;
REVOKE SELECT ON TABLE public.encrypted_transactions  FROM anon;
REVOKE SELECT ON TABLE public.invoices                FROM anon;
REVOKE SELECT ON TABLE public.payments                FROM anon;
REVOKE SELECT ON TABLE public.pending_widget_sessions FROM anon;
REVOKE SELECT ON TABLE public.quiltt_profile_map      FROM anon;
REVOKE SELECT ON TABLE public.quiltt_webhook_inbox    FROM anon;
REVOKE SELECT ON TABLE public.source_wallets          FROM anon;
REVOKE SELECT ON TABLE public.staff_users             FROM anon;
REVOKE SELECT ON TABLE public.strike_webhook_events   FROM anon;
REVOKE SELECT ON TABLE public.subaccounts             FROM anon;
REVOKE SELECT ON TABLE public.subscriptions           FROM anon;
REVOKE SELECT ON TABLE public.user_app_grants         FROM anon;
REVOKE SELECT ON TABLE public.waitlist                FROM anon;
REVOKE SELECT ON TABLE public.webhook_delivery        FROM anon;

-- Self check.  Four assertions, each of which can actually fail:
--   1a. every RLS table in public that still holds anon table level SELECT has
--       at least one permissive SELECT or ALL policy in pg_policies whose roles
--       admit anon or PUBLIC; a table surviving without such a policy is an
--       unpoliced grant and this raises loudly;
--   1b. none of the 22 tables this file revoked still holds anon table level
--       SELECT; if a revoke silently failed this raises;
--    2. the two anon INSERT grants the public forms depend on are still there;
--    3. the tables carrying anon COLUMN level SELECT are still exactly apps and
--       platforms, so nothing here has cleared a column grant.
DO $$
DECLARE
  -- The 22 tables revoked above.  Used only for Assertion 1b.
  revoked_tables text[] := ARRAY[
    'adapter_requests',
    'agent_invitation_tokens',
    'agent_members',
    'audit_entries',
    'audit_events',
    'channel_state',
    'customers',
    'data_keys',
    'encrypted_transactions',
    'invoices',
    'payments',
    'pending_widget_sessions',
    'quiltt_profile_map',
    'quiltt_webhook_inbox',
    'source_wallets',
    'staff_users',
    'strike_webhook_events',
    'subaccounts',
    'subscriptions',
    'user_app_grants',
    'waitlist',
    'webhook_delivery'
  ];
  actual_tables  text[];
  policed_tables text[];
  unpoliced      text[];
  still_granted  text[];
  expected_cols  text[] := ARRAY['apps', 'platforms'];
  expected_cols_sorted text[];
  actual_cols    text[];
  n_insert       integer;
BEGIN
  -- Assertion 1a: every RLS table in public that still has anon table-level
  -- SELECT must have at least one permissive pg_policies row whose cmd is
  -- SELECT or ALL and whose roles admit anon (cardinality 0 = TO PUBLIC, or
  -- contains 'anon').  Computed from the catalog at apply time so it passes
  -- on both dev (9 surviving tables) and prod (more surviving tables).

  SELECT coalesce(array_agg(t.relname ORDER BY t.relname), ARRAY[]::text[])
    INTO actual_tables
    FROM (
      SELECT DISTINCT c.relname::text AS relname
        FROM pg_class c
        JOIN pg_namespace ns ON ns.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(c.relacl) AS x
       WHERE ns.nspname = 'public'
         AND c.relkind = 'r'
         AND c.relrowsecurity
         AND x.grantee = 'anon'::regrole
         AND x.privilege_type = 'SELECT'
    ) AS t;

  SELECT coalesce(
           array_agg(DISTINCT p.tablename::text ORDER BY p.tablename::text),
           ARRAY[]::text[]
         )
    INTO policed_tables
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.cmd IN ('SELECT', 'ALL')
     AND p.permissive = 'PERMISSIVE'
     AND (
           cardinality(p.roles) = 0
        OR 'anon'::name = ANY(p.roles)
     );

  SELECT coalesce(array_agg(t ORDER BY t), ARRAY[]::text[])
    INTO unpoliced
    FROM unnest(actual_tables) AS t
   WHERE t <> ALL(policed_tables);

  IF array_length(unpoliced, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'Assertion 1a: RLS table(s) still hold anon SELECT without an admitting policy: %',
      unpoliced;
  END IF;

  -- Assertion 1b: none of the 22 revoked tables still holds anon table-level SELECT.
  SELECT coalesce(array_agg(t.relname ORDER BY t.relname), ARRAY[]::text[])
    INTO still_granted
    FROM (
      SELECT DISTINCT c.relname::text AS relname
        FROM pg_class c
        JOIN pg_namespace ns ON ns.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(c.relacl) AS x
       WHERE ns.nspname = 'public'
         AND c.relkind = 'r'
         AND c.relrowsecurity
         AND x.grantee = 'anon'::regrole
         AND x.privilege_type = 'SELECT'
         AND c.relname = ANY(revoked_tables)
    ) AS t;

  IF array_length(still_granted, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'Assertion 1b: revoked table(s) still hold anon SELECT: %',
      still_granted;
  END IF;

  -- Assertion 2: the two anon INSERT grants the public forms depend on are still there.
  SELECT count(*)
    INTO n_insert
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) AS x
   WHERE ns.nspname = 'public'
     AND c.relname IN ('adapter_requests', 'waitlist')
     AND x.grantee = 'anon'::regrole
     AND x.privilege_type = 'INSERT';

  IF n_insert <> 2 THEN
    RAISE EXCEPTION
      'anon INSERT on adapter_requests and waitlist must survive this file. expected 2, found %',
      n_insert;
  END IF;

  -- Assertion 3: the tables carrying anon COLUMN level SELECT are still exactly apps and platforms.
  SELECT coalesce(array_agg(t.relname ORDER BY t.relname), ARRAY[]::text[])
    INTO actual_cols
    FROM (
      SELECT DISTINCT c.relname::text AS relname
        FROM pg_class c
        JOIN pg_namespace ns ON ns.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        CROSS JOIN LATERAL aclexplode(a.attacl) AS x
       WHERE ns.nspname = 'public'
         AND c.relkind = 'r'
         AND x.grantee = 'anon'::regrole
         AND x.privilege_type = 'SELECT'
    ) AS t;

  SELECT array_agg(e ORDER BY e) INTO expected_cols_sorted FROM unnest(expected_cols) AS e;

  IF actual_cols IS DISTINCT FROM expected_cols_sorted THEN
    RAISE EXCEPTION
      'anon column level SELECT grants changed. expected tables=% actual=%',
      expected_cols_sorted, actual_cols;
  END IF;
END
$$;
