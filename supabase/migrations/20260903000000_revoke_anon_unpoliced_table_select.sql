-- Revoke the unpoliced anon table level SELECT grants on RLS enabled tables
-- in schema public (OR-T1421, out of the adjudication on OR-T1409 and the
-- definition settled on OR-T1548).
--
-- MEASURED ON DEV (fzwmnzmtqidumdqjdddz) BEFORE WRITING THE ORIGINAL FILE,
-- 2026-09-02:
--   31 RLS enabled tables in public grant table level SELECT to anon.
--   22 of them have no policy admitting anon for SELECT.
--    9 of them do have such a policy and are deliberately untouched.
--   anon holds column level SELECT on only two tables, apps and platforms,
--   neither of which is in the 22, so no table level REVOKE here can clear a
--   column level grant.
--   anon holds exactly two non SELECT privileges anywhere in public: INSERT on
--   adapter_requests and INSERT on waitlist.  Both are load bearing for the
--   unauthenticated public forms and both must survive this file.
--
-- MEASURED ON PROD BEFORE REPLACING THIS FILE, 2026-10-02 (DBA, OR-T0212
-- step 14 note):
--   40 RLS enabled tables in public grant table level SELECT to anon.
--   22 of them have no policy admitting anon for SELECT (the revoke targets).
--   18 of them have such a policy and are deliberately untouched.
--   Two of the 22 differ from the dev-measured list:
--     data_keys: anon holds no SELECT on prod, so the original REVOKE was a
--       no-op.  Removed from the list.
--     beta_approved_users: anon holds SELECT on prod and the only policy is
--       {authenticated}, so it belongs in the revoke set.  Added.
--   The DO block in the original file asserted the surviving set as a
--   hardcoded nine-element list from the dev measurement.  On prod the
--   surviving set is 18 elements, so the assertion always raised and the
--   transaction always rolled back.  The assertion is replaced below with a
--   catalog-derived form that produces the correct expected set on any
--   cluster.
--
-- CLIENT SURFACE: no client path reads any of the 22 tables while
-- unauthenticated.  Verified per table at dev HEAD (sites/world/src and src):
--
--   beta_approved_users: read in sites/world/src/lib/authClient.ts:45 using
--     the anon-key Supabase client.  The call is guarded: line 41 returns
--     {state:"anonymous"} when getSession() returns no session, so the FROM
--     query only executes for an authenticated user.  The RLS policy on the
--     table is {authenticated}.  No pre-auth read exists.  Safe to revoke.
--
--   waitlist: from("waitlist") has zero matches in the client source
--     (sites/world/src and src).  The string "#waitlist" appears as a DOM
--     anchor in Navbar.tsx and PricingCard.tsx only.  No pre-auth read.
--     Safe to revoke.
--
--   adapter_requests, agent_invitation_tokens, agent_members, audit_entries,
--   audit_events, channel_state, customers, encrypted_transactions, invoices,
--   payments, pending_widget_sessions, quiltt_profile_map,
--   quiltt_webhook_inbox, source_wallets, staff_users, strike_webhook_events,
--   subaccounts, subscriptions, user_app_grants, webhook_delivery:
--     All reads are in authenticated app routes (src/routes/app.tsx and
--     src/components/) or in edge functions that run server-side under
--     service-role or a caller-supplied JWT.  No pre-auth client read exists
--     for any of these tables.  Safe to revoke.
--
--   Reference: verified by code_search on the local clone at e5e5a2c7
--   (_tmp-or-t2561-merge) and by gh_get_file on dev HEAD for
--   sites/world/src/lib/authClient.ts (the only file with a relevant read
--   path).
--
-- REVERSIBLE: yes.  To undo, re-grant:
--   GRANT SELECT ON TABLE public.adapter_requests        TO anon;
--   GRANT SELECT ON TABLE public.agent_invitation_tokens TO anon;
--   GRANT SELECT ON TABLE public.agent_members           TO anon;
--   GRANT SELECT ON TABLE public.audit_entries           TO anon;
--   GRANT SELECT ON TABLE public.audit_events            TO anon;
--   GRANT SELECT ON TABLE public.beta_approved_users     TO anon;
--   GRANT SELECT ON TABLE public.channel_state           TO anon;
--   GRANT SELECT ON TABLE public.customers               TO anon;
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
-- IDEMPOTENT: REVOKE on a privilege that is already absent is a no op, so
-- this file is safe to re-run.  The assertion block is an equality check on
-- the surviving set rather than an absence check on the 22, so a twenty third
-- table appearing later fails it instead of passing silently.

REVOKE SELECT ON TABLE public.adapter_requests        FROM anon;
REVOKE SELECT ON TABLE public.agent_invitation_tokens FROM anon;
REVOKE SELECT ON TABLE public.agent_members           FROM anon;
REVOKE SELECT ON TABLE public.audit_entries           FROM anon;
REVOKE SELECT ON TABLE public.audit_events            FROM anon;
REVOKE SELECT ON TABLE public.channel_state           FROM anon;
REVOKE SELECT ON TABLE public.customers               FROM anon;
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

-- beta_approved_users exists on prod only.  A bare REVOKE on an absent table
-- raises 42P01, so the statement is guarded.
DO $$
BEGIN
  IF to_regclass('public.beta_approved_users') IS NOT NULL THEN
    EXECUTE 'REVOKE SELECT ON TABLE public.beta_approved_users FROM anon';
  END IF;
END
$$;

-- Self check.  Three assertions, each of which can actually fail:
--   1. the surviving set of anon table level SELECT grants on RLS tables is
--      EXACTLY the set that a policy admits (equality, not absence).  The
--      expected set is derived from the catalog rather than hardcoded, so
--      this assertion is correct on any cluster regardless of which tables
--      exist.
--   2. the two anon INSERT grants the public forms depend on are still there;
--   3. the tables carrying anon COLUMN level SELECT are still exactly apps and
--      platforms, so nothing here has cleared a column grant.
DO $$
DECLARE
  expected_sorted text[];
  actual_tables   text[];
  expected_cols   text[] := ARRAY['apps', 'platforms'];
  expected_cols_sorted text[];
  actual_cols     text[];
  n_insert        integer;
BEGIN
  SELECT array_agg(e ORDER BY e) INTO expected_cols_sorted FROM unnest(expected_cols) AS e;

  -- Expected survivors: RLS-on tables in public where a policy admits anon
  -- for SELECT (either the role list contains 'anon' directly, or it contains
  -- the pseudo-role 'public' which includes anon).  This is the catalog form
  -- of what the original file hardcoded as a nine-element list.
  SELECT coalesce(array_agg(tablename ORDER BY tablename), ARRAY[]::text[])
    INTO expected_sorted
    FROM (
      SELECT DISTINCT p.tablename::text
        FROM pg_policies p
        JOIN pg_class c ON c.relname = p.tablename
        JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE p.schemaname = 'public'
         AND ns.nspname  = 'public'
         AND c.relkind = 'r'
         AND c.relrowsecurity
         AND p.cmd IN ('SELECT', 'ALL')
         AND (p.roles @> ARRAY['anon']::name[] OR p.roles @> ARRAY['public']::name[])
    ) AS t;

  -- Actual: tables that still hold an anon table level SELECT grant.
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

  IF actual_tables IS DISTINCT FROM expected_sorted THEN
    RAISE EXCEPTION
      'anon table level SELECT on RLS tables in public is not the expected set.'
      ' expected=% actual=%',
      expected_sorted, actual_tables;
  END IF;

  -- Assertion 2: the two anon INSERT grants the public forms depend on.
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
      'anon INSERT on adapter_requests and waitlist must survive this file.'
      ' expected 2, found %',
      n_insert;
  END IF;

  -- Assertion 3: column level anon SELECT is still exactly apps and platforms.
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

  IF actual_cols IS DISTINCT FROM expected_cols_sorted THEN
    RAISE EXCEPTION
      'anon column level SELECT grants changed.'
      ' expected tables=% actual=%',
      expected_cols_sorted, actual_cols;
  END IF;
END
$$;
