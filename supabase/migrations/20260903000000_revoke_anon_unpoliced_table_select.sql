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
-- file is safe to re-run.  The assertion block below is written as an equality
-- check on the surviving set rather than as an absence check on the 22, so a
-- twenty third table appearing later fails it instead of passing silently.

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

-- Self check.  Three assertions, each of which can actually fail:
--   1. the surviving set of anon table level SELECT grants on RLS tables is
--      EXACTLY the nine that a policy admits (equality, not absence);
--   2. the two anon INSERT grants the public forms depend on are still there;
--   3. the tables carrying anon COLUMN level SELECT are still exactly apps and
--      platforms, so nothing here has cleared a column grant.
DO $$
DECLARE
  expected_tables text[] := ARRAY[
    'exchange_rate_resolutions',
    'exchange_rates',
    'quiltt_institutions_cache',
    'stealth_connections',
    'stealth_scan_ranges',
    'stealth_transactions',
    'stealth_utxos',
    'workspace_admins',
    'wrapped_data_keys'
  ];
  expected_sorted text[];
  actual_tables   text[];
  expected_cols   text[] := ARRAY['apps', 'platforms'];
  expected_cols_sorted text[];
  actual_cols     text[];
  n_insert        integer;
BEGIN
  SELECT array_agg(e ORDER BY e) INTO expected_sorted FROM unnest(expected_tables) AS e;
  SELECT array_agg(e ORDER BY e) INTO expected_cols_sorted FROM unnest(expected_cols) AS e;

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
      'anon table level SELECT on RLS tables in public is not the expected set. expected=% actual=%',
      expected_sorted, actual_tables;
  END IF;

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
      'anon column level SELECT grants changed. expected tables=% actual=%',
      expected_cols_sorted, actual_cols;
  END IF;
END
$$;
