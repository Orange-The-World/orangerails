-- Table privilege allow list for the three co-admin key tables (OR-T0788).
--
-- WHAT THIS FILE DOES
--   States, as an explicit allow list, the table level privileges that
--   public.data_keys, public.wrapped_data_keys and public.workspace_admins
--   hand to the browser facing roles, so each role holds exactly what its row
--   level security policies use and nothing else. Same shape as the four vault
--   tables sealed in 20260831155716.
--
-- MEASURED ON DEV (fzwmnzmtqidumdqjdddz) BEFORE WRITING THIS FILE, 2026-09-04.
--   pg_class.relacl, table level:
--     data_keys          postgres=arwdDxtm, authenticated=arwd, service_role=arwdDxtm, or_agent_reader=r
--     workspace_admins   postgres=arwdDxtm, authenticated=arwd, service_role=arwdDxtm, or_agent_reader=r
--     wrapped_data_keys  postgres=arwdDxtm, authenticated=arwd, service_role=arwdDxtm
--   anon is already absent from all three, and row level security is enabled
--   on all three (relrowsecurity = true).
--   Column level: or_agent_reader holds SELECT on seven named columns of
--   wrapped_data_keys and on nothing else here. A table level REVOKE cannot
--   clear a column level grant and this file does not try to; the assertion
--   block proves those seven survive.
--
--   The policies, read off pg_policy in the same session:
--     data_keys          SELECT only, TO authenticated
--     workspace_admins   SELECT TO authenticated, INSERT and DELETE TO public
--     wrapped_data_keys  SELECT TO authenticated, INSERT and DELETE TO public
--   So authenticated holds UPDATE on all three with no policy admitting an
--   UPDATE, and INSERT and DELETE on data_keys with no policy admitting
--   either. Those are the privileges this file removes.
--
-- EFFECT ON A LIVE PATH: none, and the reason is worth stating rather than
-- asserting. With row level security enabled and no policy for a command, that
-- command is already refused for authenticated, so the privileges removed here
-- cannot be exercised today. What changes is which layer refuses, and with it
-- the error text: a row level refusal becomes a permission refusal. Nothing
-- that succeeds today stops succeeding.
--   Client surface checked at the same time: the co-admin grant path inserts
--   into wrapped_data_keys and workspace_admins, the revoke path deletes from
--   both, and no client path reads or writes data_keys at all. Both surviving
--   write paths keep the privilege they use.
--
-- REVERSIBLE: yes, exactly, and this restores the state measured above.
--   GRANT INSERT, UPDATE, DELETE ON TABLE public.data_keys         TO authenticated;
--   GRANT UPDATE                 ON TABLE public.workspace_admins  TO authenticated;
--   GRANT UPDATE                 ON TABLE public.wrapped_data_keys TO authenticated;
--
-- IDEMPOTENT: the file revokes everything from the role and grants the set
-- back, so it states an absolute set rather than a delta and re-running lands
-- on the same state. service_role, or_agent_reader and postgres are never
-- named and are not touched.
--
-- LOCKING: GRANT and REVOKE take a brief ACCESS EXCLUSIVE lock on the relation.
-- Neither rewrites the table nor scans any row.

REVOKE ALL ON TABLE public.data_keys         FROM authenticated;
REVOKE ALL ON TABLE public.workspace_admins  FROM authenticated;
REVOKE ALL ON TABLE public.wrapped_data_keys FROM authenticated;

GRANT SELECT                 ON TABLE public.data_keys         TO authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.workspace_admins  TO authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.wrapped_data_keys TO authenticated;

-- PUBLIC and anon are named explicitly rather than left implicit, so the allow
-- list is a statement about every browser facing grantee and not only about the
-- one that was over granted. Both hold nothing on these three tables today, so
-- these two statements are no ops and are here to keep it that way.
REVOKE ALL ON TABLE public.data_keys, public.workspace_admins, public.wrapped_data_keys FROM PUBLIC;
REVOKE ALL ON TABLE public.data_keys, public.workspace_admins, public.wrapped_data_keys FROM anon;

-- Self check. Five assertions, each of which can actually fail:
--   1. authenticated holds EXACTLY the expected privilege set on each table,
--      compared as a set rather than as a list of absences, so a privilege
--      appearing later fails this instead of passing silently;
--   2. anon and PUBLIC hold nothing at table level on any of the three;
--   3. service_role keeps SELECT on all three;
--   4. or_agent_reader keeps its table level SELECT on the two it had it on;
--   5. or_agent_reader keeps its column level SELECT on the seven named
--      columns of wrapped_data_keys, which a table wide REVOKE has cleared on
--      another table before now.
-- Checks 4 and 5 are skipped with a NOTICE, loudly, on a cluster where the
-- or_agent_reader role does not exist, rather than raising on a role this file
-- does not create.
DO $$
DECLARE
  r        record;
  actual   text[];
  expected text[];
  n        integer;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('data_keys',         ARRAY['SELECT']),
      ('workspace_admins',  ARRAY['DELETE', 'INSERT', 'SELECT']),
      ('wrapped_data_keys', ARRAY['DELETE', 'INSERT', 'SELECT'])
    ) AS t(relname, want)
  LOOP
    expected := r.want;

    SELECT coalesce(array_agg(DISTINCT x.privilege_type ORDER BY x.privilege_type), ARRAY[]::text[])
      INTO actual
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) AS x
     WHERE ns.nspname = 'public'
       AND c.relname  = r.relname
       AND x.grantee  = 'authenticated'::regrole;

    IF actual IS DISTINCT FROM expected THEN
      RAISE EXCEPTION
        'assert failed: authenticated holds % on public.%, expected exactly %',
        actual, r.relname, expected;
    END IF;

    SELECT count(*)
      INTO n
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) AS x
     WHERE ns.nspname = 'public'
       AND c.relname  = r.relname
       AND (x.grantee = 0::oid OR x.grantee = 'anon'::regrole);

    IF n <> 0 THEN
      RAISE EXCEPTION
        'assert failed: anon or PUBLIC still holds % table level privilege(s) on public.%',
        n, r.relname;
    END IF;
  END LOOP;

  SELECT count(*)
    INTO n
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) AS x
   WHERE ns.nspname = 'public'
     AND c.relname IN ('data_keys', 'workspace_admins', 'wrapped_data_keys')
     AND x.grantee = 'service_role'::regrole
     AND x.privilege_type = 'SELECT';

  IF n <> 3 THEN
    RAISE EXCEPTION
      'assert failed: service_role must keep SELECT on all three co-admin key tables, expected 3, found %',
      n;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'or_agent_reader') THEN
    SELECT count(*)
      INTO n
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) AS x
     WHERE ns.nspname = 'public'
       AND c.relname IN ('data_keys', 'workspace_admins')
       AND x.grantee = 'or_agent_reader'::regrole
       AND x.privilege_type = 'SELECT';

    IF n <> 2 THEN
      RAISE EXCEPTION
        'assert failed: or_agent_reader must keep table level SELECT on data_keys and workspace_admins, expected 2, found %',
        n;
    END IF;

    SELECT count(*)
      INTO n
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      CROSS JOIN LATERAL aclexplode(a.attacl) AS x
     WHERE ns.nspname = 'public'
       AND c.relname  = 'wrapped_data_keys'
       AND x.grantee  = 'or_agent_reader'::regrole
       AND x.privilege_type = 'SELECT';

    IF n <> 7 THEN
      RAISE EXCEPTION
        'assert failed: or_agent_reader column level SELECT on public.wrapped_data_keys changed, expected 7 columns, found %',
        n;
    END IF;
  ELSE
    RAISE NOTICE
      'or_agent_reader does not exist on this cluster, so its retention checks were SKIPPED, not passed';
  END IF;

  RAISE NOTICE
    'co-admin key table grant allow list ok: authenticated holds SELECT on data_keys and SELECT, INSERT, DELETE on workspace_admins and wrapped_data_keys, anon and PUBLIC hold nothing';
END
$$;
