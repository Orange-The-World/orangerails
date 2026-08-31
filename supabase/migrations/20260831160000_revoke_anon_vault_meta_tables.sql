-- ============================================================
-- Remove the anon table grant from the two vault meta tables
-- ============================================================
-- Ticket:  OR-T1155 (P2, risk)
-- Related: OR-T0701, OR-T0717, OR-T0963, OR-T1027 (the same class of
--          privilege arriving by default and nobody having stated it),
--          OR-T1145 (found while writing it), 20260809140000 (the DELETE
--          and TRUNCATE half of this, already landed)
--
-- ------------------------------------------------------------
-- WHY
-- ------------------------------------------------------------
-- public.user_vault_meta and public.customer_vault_meta hold, per row,
-- the vault salt, the verifier ciphertext, the wrapped master key, the
-- recovery blob and the wrapped PQC secret keys. Read live from
-- pg_class.relacl on 2026-08-31:
--
--   hosted prod lcdicqalreskibdfxkzb
--     user_vault_meta     : postgres=arwdDxtm, anon=arw, authenticated=arw, service_role=arwxtm
--     customer_vault_meta : postgres=arwdDxtm, anon=arw, authenticated=arw, service_role=arwxtm
--   hosted dev fzwmnzmtqidumdqjdddz
--     user_vault_meta     : postgres=arwdDxtm, service_role=arwxtm, authenticated=r
--     customer_vault_meta : postgres=arwdDxtm, service_role=arwxtm, authenticated=arw
--
-- So on production the ANONYMOUS role holds SELECT, INSERT and UPDATE on
-- both tables. Column level ACLs were read on the same day and there are
-- none on either table on either cluster, so the table level grant is the
-- whole of it and nothing is hiding underneath.
--
-- WHAT ACTUALLY HOLDS TODAY, stated so this is not read as an open door.
-- Row level security is enabled on both tables on production and every
-- policy on both names the authenticated role only: insert own, read own,
-- update own, and co-admins read owner. anon matches no policy and
-- therefore reaches zero rows. All policy definitions were read, not
-- assumed.
--
-- A grant is the wall and a policy is the door. Right now there is no
-- wall, only a door, so the whole protection of this material against the
-- anonymous role rests on those policy rows continuing to name the right
-- role. Add one policy with TO public, or disable row level security for
-- a moment during an incident, and anon has read and write on customer
-- key material with no second control behind it. Grants and policies are
-- enforced by different mechanisms at different points, so a policy
-- cannot express "this role may never touch this table" and only a
-- REVOKE closes it.
--
-- ------------------------------------------------------------
-- WHY THE anon GRANT CAN GO, checked rather than assumed
-- ------------------------------------------------------------
-- Every call site for public.user_vault_meta in this repository was read
-- on 2026-08-31, at ref prod for the client routes:
--
--   src/routes/signup.tsx:145   select   after an explicit early return when getSession() is null
--   src/routes/signup.tsx:223   insert   after signUp() which throws without a session, or after
--                                        an explicit "Session lost" throw on the resume path
--   src/routes/unlock.tsx:40    select   after redirecting to /login when there is no session
--   src/routes/recover.tsx:55   select   after "You must be signed in to recover your vault."
--   src/routes/app.tsx          select and update, inside the authenticated app shell
--   src/lib/pqc-lifecycle.ts    select and update, called with an established session
--   src/lib/co-admin.ts         update, called with an established session
--   src/context/VaultContext.tsx update, called with an established session
--
-- Every one of them runs with a session, which means the request carries
-- the authenticated role, not anon. A repository wide search found ZERO
-- references to either table under supabase/functions, so no edge
-- function reaches them under any role. customer_vault_meta has no call
-- site anywhere outside the generated type definitions.
--
-- Role inheritance was checked too, because a revoke on anon would be
-- dangerous if authenticated inherited from it. Read from pg_auth_members
-- on production: authenticator and postgres are members of anon,
-- authenticated and service_role. authenticated is NOT a member of anon.
-- So removing a privilege from anon cannot remove it from authenticated.
--
-- ------------------------------------------------------------
-- WHY NOW
-- ------------------------------------------------------------
-- Both tables are EMPTY on production: 0 rows in each, counted on
-- 2026-08-31. Nothing in service can break, no customer can be locked
-- out, and there is no data to restore if this were somehow wrong. The
-- exposure is entirely in the future, and the cheapest moment to remove a
-- privilege is before anything depends on it.
--
-- ------------------------------------------------------------
-- CONVERGENCE, and the drift that made this necessary
-- ------------------------------------------------------------
-- Hosted dev already has no anon grant on either table. No migration in
-- supabase/migrations produces that state: searches for the table name
-- next to anon, and for a REVOKE naming either table, return nothing. So
-- the dev shape was applied out of band, which is exactly why production
-- never received it and why a rebuild of dev would not reproduce it.
-- This file is what makes the two clusters agree and keeps them agreeing.
-- On dev it is a no-op by design, and the assertion below still runs
-- there, so dev proves the assertion rather than skipping it.
--
-- ------------------------------------------------------------
-- SCOPE, and what is deliberately NOT here
-- ------------------------------------------------------------
-- Four other tables in this family also carry an anon table grant on
-- production: customer_recovery_shares, opk_key_rotations,
-- platform_key_audit and vault_security_events. They are NOT in this file.
-- They carry the same grant on hosted dev as well, so unlike the two
-- vault meta tables there is no already-proven shape to converge on, two
-- of them hold rows, and each needs its own answer to "what reaches this
-- as anon" before a privilege is taken away. That is its own change.
--
-- Trimming the authenticated role to least privilege is also not here.
-- Hosted dev holds authenticated=r at table level on user_vault_meta with
-- column level write grants, production holds authenticated=arw at table
-- level. Converging THAT is a separate decision with a real blast radius,
-- and mixing it into a revoke aimed at anon would make this file
-- impossible to review or to revert cleanly.
--
-- ------------------------------------------------------------
-- IDEMPOTENT
-- ------------------------------------------------------------
-- Yes. REVOKE of a privilege that is not held changes nothing and does
-- not error. A second run is a no-op and the assertion still passes. The
-- to_regclass guard means a cluster missing either table is skipped
-- loudly with a NOTICE rather than failing.
--
-- ------------------------------------------------------------
-- REVERSIBLE
-- ------------------------------------------------------------
-- Yes, and the down path is one statement per table:
--   GRANT SELECT, INSERT, UPDATE ON public.user_vault_meta     TO anon;
--   GRANT SELECT, INSERT, UPDATE ON public.customer_vault_meta TO anon;
-- Doing that restores the exposure this file exists to remove, so it is a
-- rollback of last resort. No data is touched by this migration in either
-- direction, so there is nothing to restore from a backup.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Say what is actually being removed, per table, BEFORE removing it.
--    A revoke is silent when there was nothing to revoke, so without this
--    the apply output cannot tell "removed three privileges" from "did
--    nothing at all". That difference is the entire point of the file.
-- ------------------------------------------------------------
DO $pre$
DECLARE
  v_tbl  text;
  v_held text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['user_vault_meta', 'customer_vault_meta']
  LOOP
    IF to_regclass('public.' || v_tbl) IS NULL THEN
      RAISE NOTICE 'OR-T1155: public.% does not exist on this cluster, skipping', v_tbl;
      CONTINUE;
    END IF;

    SELECT coalesce(string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type), '<none>')
      INTO v_held
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
      JOIN pg_roles r ON r.oid = a.grantee
     WHERE n.nspname = 'public'
       AND c.relname = v_tbl
       AND r.rolname = 'anon';

    RAISE NOTICE 'OR-T1155: anon holds % on public.% before this migration', v_held, v_tbl;
  END LOOP;
END
$pre$;

-- ------------------------------------------------------------
-- 2. The revoke. PUBLIC is named as well as anon: neither table grants
--    anything to PUBLIC today, but a privilege inherited through PUBLIC
--    would survive a revoke that named only the role, and this file is
--    supposed to leave anon with nothing by any route.
-- ------------------------------------------------------------
DO $revoke$
DECLARE
  v_tbl text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['user_vault_meta', 'customer_vault_meta']
  LOOP
    IF to_regclass('public.' || v_tbl) IS NULL THEN
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', v_tbl);
    END IF;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', v_tbl);
  END LOOP;
END
$revoke$;

-- ------------------------------------------------------------
-- 3. Prove it. This block can go red, which is the only reason it is
--    worth writing: it re-reads the live catalogue rather than trusting
--    the loop above to have run, and it checks the two roles that must
--    NOT have lost anything as well as the one that must have lost
--    everything. A file that only asserts what it did is asserting
--    nothing.
-- ------------------------------------------------------------
DO $assert$
DECLARE
  v_tbl  text;
  v_left text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['user_vault_meta', 'customer_vault_meta']
  LOOP
    IF to_regclass('public.' || v_tbl) IS NULL THEN
      CONTINUE;
    END IF;

    -- anon must hold nothing, by name or through PUBLIC.
    SELECT coalesce(string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type), '')
      INTO v_left
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE n.nspname = 'public'
       AND c.relname = v_tbl
       AND (a.grantee = 0 OR a.grantee = 'anon'::regrole::oid);

    IF v_left <> '' THEN
      RAISE EXCEPTION 'OR-T1155 assert: anon or PUBLIC still holds % on public.%', v_left, v_tbl;
    END IF;

    -- and nothing may have been granted back at column level either,
    -- because a table level revoke does not touch column level grants.
    IF EXISTS (
      SELECT 1
        FROM pg_attribute at
        JOIN pg_class c ON c.oid = at.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(at.attacl) a
       WHERE n.nspname = 'public'
         AND c.relname = v_tbl
         AND (a.grantee = 0 OR a.grantee = 'anon'::regrole::oid)
    ) THEN
      RAISE EXCEPTION 'OR-T1155 assert: anon or PUBLIC holds a COLUMN level grant on public.%', v_tbl;
    END IF;

    -- service_role must keep SELECT, or every server side path breaks.
    IF NOT has_table_privilege('service_role', format('public.%I', v_tbl), 'SELECT') THEN
      RAISE EXCEPTION 'OR-T1155 assert: service_role lost SELECT on public.%', v_tbl;
    END IF;

    -- authenticated must keep SELECT, or the owner cannot read their own
    -- vault. This is the check that catches a revoke aimed at the wrong
    -- role, which is the one way this file could do real damage.
    IF NOT has_table_privilege('authenticated', format('public.%I', v_tbl), 'SELECT') THEN
      RAISE EXCEPTION 'OR-T1155 assert: authenticated lost SELECT on public.%', v_tbl;
    END IF;

    RAISE NOTICE 'OR-T1155: public.% now grants anon nothing, authenticated and service_role intact', v_tbl;
  END LOOP;
END
$assert$;

COMMIT;
