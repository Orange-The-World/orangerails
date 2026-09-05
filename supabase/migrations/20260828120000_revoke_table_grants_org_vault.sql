-- 20260828120000_revoke_table_grants_org_vault.sql
--
-- Give the four org vault tables an explicit table privilege allow list.
--
-- WHAT THIS FIXES
-- 20260815000001_vault_member_slots_org_vault.sql creates user_vault_pubkeys,
-- org_vault_meta, vault_member_slots and org_recovery_challenges. It enables row
-- level security on all four and gives each one permissive SELECT policy scoped
-- to auth.uid(). It issues no REVOKE.
--
-- The default privileges on schema public grant every table privilege to anon
-- and to authenticated on any table created there, so all four tables were
-- created carrying the full set for both roles. Measured on the dev project on
-- 2026-08-28, each of the four reports anon=arwdDxtm and authenticated=arwdDxtm
-- in pg_class.relacl. The requirement that these tables carry an explicit revoke
-- has been part of the design since revision 5 and was never written into a
-- migration.
--
-- THE SHAPE, which is the same for every sealed table and is not negotiable per
-- table: one block per table, PUBLIC always named even where it currently holds
-- nothing, and the grant written out as an allow list. No ALL TABLES IN SCHEMA,
-- no comma separated multi table REVOKE. Every table gets its own block, so
-- there is no main block for a statement to be accidentally inside or outside
-- of.
--
-- WHY authenticated KEEPS SELECT. All four tables are read directly through
-- PostgREST under a policy scoped to auth.uid(). Revoking SELECT from
-- authenticated would make those four policies dead code and break member reads.
-- None of the four has an INSERT, UPDATE or DELETE policy, so removing those
-- privileges from authenticated takes away privileges that no working path uses.
--
-- WHY THERE IS NO FORCE ROW LEVEL SECURITY HERE, stated so nobody adds it later
-- thinking it was an oversight. FORCE subjects the table owner to row level
-- security, and the SECURITY DEFINER functions this design routes writes through
-- execute as the owner. Mandating FORCE would apply row level security to the
-- one path that has to bypass it.
--
-- WHY service_role IS UNTOUCHED. It is the server side identity the Edge
-- Function write path runs as, and it is never exposed to a browser.
--
-- Idempotent. REVOKE and GRANT can be re-run. The assertions at the end fail
-- loudly rather than letting a partial apply look like a success.

-- user_vault_pubkeys: one X25519 public key plus the sealed private key per user.
ALTER TABLE public.user_vault_pubkeys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_vault_pubkeys FROM PUBLIC;
REVOKE ALL ON TABLE public.user_vault_pubkeys FROM anon;
REVOKE ALL ON TABLE public.user_vault_pubkeys FROM authenticated;
GRANT SELECT ON TABLE public.user_vault_pubkeys TO authenticated;

-- org_vault_meta: org vault recovery public keys and the wrapped recovery slot.
ALTER TABLE public.org_vault_meta ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.org_vault_meta FROM PUBLIC;
REVOKE ALL ON TABLE public.org_vault_meta FROM anon;
REVOKE ALL ON TABLE public.org_vault_meta FROM authenticated;
GRANT SELECT ON TABLE public.org_vault_meta TO authenticated;

-- vault_member_slots: the per member wrapped copy of the vault key.
ALTER TABLE public.vault_member_slots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.vault_member_slots FROM PUBLIC;
REVOKE ALL ON TABLE public.vault_member_slots FROM anon;
REVOKE ALL ON TABLE public.vault_member_slots FROM authenticated;
GRANT SELECT ON TABLE public.vault_member_slots TO authenticated;

-- org_recovery_challenges: single use recovery challenge nonces.
ALTER TABLE public.org_recovery_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.org_recovery_challenges FROM PUBLIC;
REVOKE ALL ON TABLE public.org_recovery_challenges FROM anon;
REVOKE ALL ON TABLE public.org_recovery_challenges FROM authenticated;
GRANT SELECT ON TABLE public.org_recovery_challenges TO authenticated;

-- Prove it, rather than assume the statements above did what they say.
-- Three separate assertions, because "anon holds nothing", "authenticated holds
-- no write privilege" and "authenticated can still read" are three different
-- facts and a migration that can only report the first is not worth much.
DO $$
DECLARE
  sealed_tables text[] := ARRAY[
    'public.user_vault_pubkeys',
    'public.org_vault_meta',
    'public.vault_member_slots',
    'public.org_recovery_challenges'
  ];
  offenders text;
BEGIN
  -- 1. anon must hold nothing at all on any of the four.
  SELECT string_agg(t, ', ' ORDER BY t) INTO offenders
  FROM unnest(sealed_tables) AS t
  WHERE has_table_privilege('anon', t,
        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER');
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'anon still holds a table privilege after the revoke block on: %', offenders;
  END IF;

  -- 2. authenticated must hold no write privilege on any of the four.
  SELECT string_agg(t, ', ' ORDER BY t) INTO offenders
  FROM unnest(sealed_tables) AS t
  WHERE has_table_privilege('authenticated', t,
        'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER');
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'authenticated still holds a write privilege after the revoke block on: %', offenders;
  END IF;

  -- 3. authenticated must still be able to read all four, or the member facing
  --    SELECT policies are dead code and this migration broke the read path.
  SELECT string_agg(t, ', ' ORDER BY t) INTO offenders
  FROM unnest(sealed_tables) AS t
  WHERE NOT has_table_privilege('authenticated', t, 'SELECT');
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'authenticated lost SELECT, the member read path is broken on: %', offenders;
  END IF;
END;
$$;
