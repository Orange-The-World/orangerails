-- 20260828181500_revoke_table_grants_coadmin_tables.sql
--
-- DEV-0325. Give the three co-admin tables an explicit table privilege allow list.
--
-- WHAT THIS FIXES. public.wrapped_data_keys, public.data_keys and
-- public.workspace_admins were created in schema public while the default privileges
-- still granted every table privilege to anon and to authenticated, and no migration
-- ever revoked them. Measured on the dev project on 2026-08-28, pg_class.relacl:
--   wrapped_data_keys -> anon=arwdDxtm, authenticated=arwdDxtm
--   data_keys         -> anon=arwdDxtm, authenticated=arwdDxtm
--   workspace_admins  -> anon=arwdDxtm, authenticated=arwdDxtm
-- Compare the tables already sealed by 20260828120000 and by the DEV-0290 work, same
-- query, same day: anon absent, authenticated holding only what its policies use.
-- These three are the last of the vault surface still carrying the default, and they
-- are the ones holding the wrapped key material for a co-admin grant, the data key
-- rows, and the grant membership.
--
-- HOW BAD, stated honestly rather than inflated. Row level security is enabled on all
-- three (relrowsecurity = true, verified live). Every policy on them is keyed on
-- auth.uid(), which is null for an anon caller, so an anon request matches no row.
-- No anon read or write reaching any of the three has been demonstrated and none is
-- claimed here. The table grant is a layer that should not be there; row level
-- security is the layer actually holding. It matters because it is the difference
-- between "anon holds nothing on the vault surface" being true and being nearly true,
-- and because it is the layer left standing alone the first time a policy is added
-- without a role list, which is the shape the wrapped_data_keys policies already have
-- (polroles is null on all three of them, so they apply to PUBLIC).
--
-- THE ALLOW LIST IS NOT COPIED, it is read off each table's policies.
--   wrapped_data_keys: SELECT (recipient read policy), INSERT (owner grants),
--                      DELETE (owner revokes) -> SELECT, INSERT, DELETE.
--   workspace_admins:  SELECT (owner and admin read), INSERT (owner adds),
--                      DELETE (owner removes) -> SELECT, INSERT, DELETE.
--   data_keys:         one policy only, data_keys_owner_select, and it is the only
--                      table of the three whose policy names a role explicitly
--                      (authenticated) -> SELECT.
-- None of the three has an UPDATE policy, so removing UPDATE from authenticated takes
-- away a privilege no working path can use: an authenticated UPDATE is already refused
-- by row level security today, and after this it is refused one layer earlier.
-- data_keys has no INSERT policy either, so rows there are created by the server side
-- identity, which this migration does not touch.
--
-- EXERCISED BEFORE WRITING, on dev, in a transaction deliberately aborted at the end so
-- nothing persisted (checked immediately afterwards: all three tables back to the old
-- relacl and the original policy counts). With exactly the allow list below in place,
-- acting as role authenticated with request.jwt.claims.sub set to the owner:
--   a co-admin GRANT   -> workspace_admins insert 1 row, wrapped_data_keys insert 1 row
--   an owner read      -> data_keys select 1 row
--   a co-admin REVOKE  -> workspace_admins delete 1 row
--   anon afterwards    -> holds no privilege on any of the three
-- One number from that run is deliberately not hidden: the owner's DELETE against
-- wrapped_data_keys removed 0 rows, both before and after this change. That is DEV-0326,
-- a missing owner SELECT policy, not a consequence of this migration; the same delete
-- removed 1 row in the same transaction once the DEV-0326 policy (PR #952) was added.
-- This migration neither causes nor fixes that.
--
-- WHY THERE IS NO FORCE ROW LEVEL SECURITY, stated so nobody adds it later thinking it
-- was an oversight. FORCE subjects the table owner to row level security, and the
-- SECURITY DEFINER paths execute as the owner.
--
-- WHY service_role IS UNTOUCHED. It is the server side identity the Edge Function write
-- path runs as, and it is never exposed to a browser.
--
-- Idempotent, and a two way door: REVOKE and GRANT can be re-run, and re-issuing
-- GRANT ALL restores the previous state exactly. No column, constraint, policy or row
-- is touched.

-- wrapped_data_keys: the per grant key material wrapped to the recipient public key.
ALTER TABLE public.wrapped_data_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.wrapped_data_keys FROM PUBLIC;
REVOKE ALL ON TABLE public.wrapped_data_keys FROM anon;
REVOKE ALL ON TABLE public.wrapped_data_keys FROM authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.wrapped_data_keys TO authenticated;

-- data_keys: the workspace data key rows. Owner read only from the browser.
ALTER TABLE public.data_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.data_keys FROM PUBLIC;
REVOKE ALL ON TABLE public.data_keys FROM anon;
REVOKE ALL ON TABLE public.data_keys FROM authenticated;
GRANT SELECT ON TABLE public.data_keys TO authenticated;

-- workspace_admins: co-admin grant membership. Owner adds and removes, both parties read.
ALTER TABLE public.workspace_admins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.workspace_admins FROM PUBLIC;
REVOKE ALL ON TABLE public.workspace_admins FROM anon;
REVOKE ALL ON TABLE public.workspace_admins FROM authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.workspace_admins TO authenticated;

-- Prove it, rather than assume the statements above did what they say. Four assertions,
-- because "anon holds nothing", "authenticated cannot update", "authenticated can still
-- read" and "the grant and revoke paths still have their privileges" are four different
-- facts, and a migration that can only report the first is not worth much.
DO $$
DECLARE
  sealed_tables text[] := ARRAY[
    'public.wrapped_data_keys',
    'public.data_keys',
    'public.workspace_admins'
  ];
  write_tables text[] := ARRAY[
    'public.wrapped_data_keys',
    'public.workspace_admins'
  ];
  offenders text;
BEGIN
  -- 1. anon must hold nothing at all on any of the three.
  SELECT string_agg(t, ', ' ORDER BY t) INTO offenders
  FROM unnest(sealed_tables) AS t
  WHERE has_table_privilege('anon', t,
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER');
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'anon still holds a table privilege after the revoke block on: %', offenders;
  END IF;

  -- 2. authenticated must hold no privilege beyond the allow list on any of the three.
  SELECT string_agg(t, ', ' ORDER BY t) INTO offenders
  FROM unnest(sealed_tables) AS t
  WHERE has_table_privilege('authenticated', t,
        'UPDATE, TRUNCATE, REFERENCES, TRIGGER');
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'authenticated still holds a privilege outside the allow list on: %', offenders;
  END IF;

  -- 3. authenticated must still be able to read all three, or the owner, recipient and
  --    admin read policies are dead code and this migration broke the read path.
  SELECT string_agg(t, ', ' ORDER BY t) INTO offenders
  FROM unnest(sealed_tables) AS t
  WHERE NOT has_table_privilege('authenticated', t, 'SELECT');
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'authenticated lost SELECT, the vault read path is broken on: %', offenders;
  END IF;

  -- 4. the two tables a co-admin grant and revoke write to must keep INSERT and DELETE,
  --    or the grant and revoke paths are broken.
  SELECT string_agg(t, ', ' ORDER BY t) INTO offenders
  FROM unnest(write_tables) AS t
  WHERE NOT has_table_privilege('authenticated', t, 'INSERT')
     OR NOT has_table_privilege('authenticated', t, 'DELETE');
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'authenticated lost INSERT or DELETE, the co-admin grant or revoke path is broken on: %', offenders;
  END IF;

  -- 5. data_keys must NOT have gained a write privilege for authenticated: it has no
  --    INSERT, UPDATE or DELETE policy, so a browser side write there is never intended.
  IF has_table_privilege('authenticated', 'public.data_keys', 'INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION
      'authenticated holds a write privilege on public.data_keys, which has no write policy';
  END IF;
END;
$$;
