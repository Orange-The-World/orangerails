-- 20260828160000_revoke_table_grants_user_and_customer_vault_meta.sql
--
-- Give user_vault_meta and customer_vault_meta an explicit table privilege
-- allow list, the same treatment 20260828120000 gave the four org vault tables.
--
-- WHAT THIS FIXES
-- The default privileges on schema public grant every table privilege to anon
-- and to authenticated on any table created there. Both of these tables were
-- created that way and no migration ever revoked it. Measured on the dev
-- project on 2026-08-28, before this migration, pg_class.relacl reported:
--
--   user_vault_meta     anon=arwxtm  authenticated=arwxtm  service_role=arwxtm
--   customer_vault_meta anon=arwxtm  authenticated=arwxtm  service_role=arwxtm
--
-- Row level security is enabled on both and every policy on both is scoped to
-- the authenticated role, so an anon caller holding these privileges matched no
-- policy and got nothing. That was verified rather than assumed: as anon, a
-- SELECT returned 0 rows and an INSERT was refused with SQLSTATE 42501. So this
-- is a missing layer of defence in depth, not an open write path, and it is
-- being closed on that basis and not on a claim of live exposure.
--
-- THE SHAPE, unchanged from 20260828120000 and not negotiable per table: one
-- block per table, PUBLIC always named even where it currently holds nothing,
-- and the grant written out as an allow list. No ALL TABLES IN SCHEMA and no
-- comma separated multi table REVOKE, so there is no main block for a statement
-- to be accidentally inside or outside of.
--
-- WHERE THIS DIFFERS FROM THE ORG VAULT FOUR, and this is the part to read
-- before copying the earlier file over this one. There, authenticated keeps
-- SELECT alone, because none of those tables has an INSERT, UPDATE or DELETE
-- policy. Here, both tables carry INSERT and UPDATE policies scoped to
-- authenticated and those are the live member vault creation and rotation
-- paths through PostgREST:
--
--   user_vault_meta      insert, select and update policies, all TO authenticated
--   customer_vault_meta  insert, select and update policies, all TO authenticated
--
-- So the allow list here is SELECT, INSERT and UPDATE. Revoking the write
-- privileges from authenticated would make those policies dead code and break
-- vault creation. Neither table has a DELETE policy, so DELETE is deliberately
-- absent from the allow list and authenticated cannot delete either row.
--
-- WHY THERE IS NO FORCE ROW LEVEL SECURITY HERE, stated so nobody adds it later
-- thinking it was an oversight. FORCE subjects the table owner to row level
-- security, and the SECURITY DEFINER functions this design routes writes
-- through execute as the owner. Mandating FORCE would apply row level security
-- to the one path that has to bypass it.
--
-- WHY service_role IS UNTOUCHED. It is the server side identity the Edge
-- Function write path runs as, and it is never exposed to a browser.
--
-- Idempotent. REVOKE and GRANT can be re-run. The assertions at the end fail
-- loudly rather than letting a partial apply look like a success.

-- user_vault_meta: per user vault salt, verifier, wrapped keys and keyring.
ALTER TABLE public.user_vault_meta ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_vault_meta FROM PUBLIC;
REVOKE ALL ON TABLE public.user_vault_meta FROM anon;
REVOKE ALL ON TABLE public.user_vault_meta FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.user_vault_meta TO authenticated;

-- customer_vault_meta: the same per customer.
ALTER TABLE public.customer_vault_meta ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.customer_vault_meta FROM PUBLIC;
REVOKE ALL ON TABLE public.customer_vault_meta FROM anon;
REVOKE ALL ON TABLE public.customer_vault_meta FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.customer_vault_meta TO authenticated;

-- Prove it, rather than assume the statements above did what they say.
--
-- These read pg_class.relacl through aclexplode instead of calling
-- has_table_privilege with a fixed privilege list. That is deliberate: a fixed
-- list can only catch the privileges someone remembered to name, and MAINTAIN
-- is a recent addition that an older list would silently skip. Asking the
-- catalogue what is actually granted catches anything, including a privilege
-- that does not exist yet.
DO $$
DECLARE
  sealed_tables text[] := ARRAY[
    'public.user_vault_meta',
    'public.customer_vault_meta'
  ];
  offenders text;
BEGIN
  -- 1. PUBLIC and anon must hold nothing at all on either table.
  SELECT string_agg(DISTINCT t || ' (' || a.privilege_type || ' to ' ||
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END || ')', ', ')
    INTO offenders
    FROM unnest(sealed_tables) AS t
    JOIN pg_class c ON c.oid = t::regclass
    CROSS JOIN LATERAL aclexplode(c.relacl) AS a
   WHERE a.grantee = 0 OR a.grantee = 'anon'::regrole;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'PUBLIC or anon still holds a table privilege after the revoke block: %', offenders;
  END IF;

  -- 2. authenticated must hold nothing outside the allow list. Stated as
  --    "not in the allow list" rather than as a list of forbidden privileges,
  --    so a privilege nobody thought of is caught too.
  SELECT string_agg(DISTINCT t || ' (' || a.privilege_type || ')', ', ') INTO offenders
    FROM unnest(sealed_tables) AS t
    JOIN pg_class c ON c.oid = t::regclass
    CROSS JOIN LATERAL aclexplode(c.relacl) AS a
   WHERE a.grantee = 'authenticated'::regrole
     AND a.privilege_type NOT IN ('SELECT','INSERT','UPDATE');
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'authenticated holds a privilege outside the allow list: %', offenders;
  END IF;

  -- 3. authenticated must still hold all three, or the member facing policies
  --    are dead code and this migration broke the vault creation path.
  SELECT string_agg(t || ':' || p, ', ') INTO offenders
    FROM unnest(sealed_tables) AS t
    CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE']) AS p
   WHERE NOT has_table_privilege('authenticated', t, p);
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'authenticated lost a privilege its policies need, the member path is broken on: %', offenders;
  END IF;
END;
$$;
