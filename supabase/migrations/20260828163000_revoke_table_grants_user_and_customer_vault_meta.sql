-- 20260828163000_revoke_table_grants_user_and_customer_vault_meta.sql
--
-- Give user_vault_meta and customer_vault_meta an explicit privilege allow
-- list, the same treatment 20260828120000 gave the four org vault tables.
--
-- WHAT THIS FIXES
-- The default privileges on schema public grant every table privilege to anon
-- and to authenticated on any table created there. Both of these tables were
-- created that way and no migration ever revoked it.
--
-- BEFORE STATE, read from the dev project on 2026-09-02 (an earlier version of
-- this header recorded a 2026-08-28 reading that no longer describes the
-- project, because part of the tightening has landed since):
--
--   pg_class.relacl
--     user_vault_meta      postgres=arwdDxtm  service_role=arwxtm  authenticated=r
--     customer_vault_meta  postgres=arwdDxtm  service_role=arwxtm  authenticated=arw
--   anon holds nothing at table level on either table today.
--
--   pg_attribute.attacl on user_vault_meta
--     authenticated=aw on 17 of the 18 live columns.
--     NO column grant on workspace_key_id (attnum 14). That is the only
--     exclusion, and it is not an accident of 17 separate grants.
--
-- That before state is the dev project's and is recorded as a measurement, not
-- as a claim about every environment. Another project may start from a
-- different ACL. The end state does not depend on where it started: the REVOKE
-- and GRANT below are absolute, not relative, and the assertions at the end
-- prove the end state rather than the change.
--
-- Row level security is enabled on both and every policy on both is scoped to
-- the authenticated role, so an anon caller holding these privileges matched no
-- policy and got nothing. That was verified rather than assumed: as anon, a
-- SELECT returned 0 rows and an INSERT was refused with SQLSTATE 42501. So this
-- is a missing layer of defence in depth, not an open write path, and it is
-- being closed on that basis and not on a claim of live exposure.
--
-- WHY THE VERSION IS 163000 AND NOT 160000. 160000 is already taken on dev by
-- 20260828160000_revoke_public_execute_vault_trigger_functions.sql.
-- supabase_migrations.schema_migrations holds one row per version, so at most
-- one file per version can ever be tracked, and the check-pending-migrations
-- step of .github/workflows/supabase-deploy.yml exits 1 when two files share a
-- version prefix, which blocks the deploy job for every later push as well.
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
-- WHY user_vault_meta IS COLUMN SCOPED AND customer_vault_meta IS NOT. Read
-- this before simplifying the two blocks into one shape.
--
-- A table level REVOKE ALL clears column level grants as well as table level
-- ones. That was probed on dev rather than assumed: a scratch table given a
-- table level SELECT plus column level INSERT and UPDATE, then REVOKE ALL ON
-- TABLE ... FROM authenticated, came back with column_acl NONE and both
-- has_insert and has_update false. So a revoke followed by a table wide
-- GRANT SELECT, INSERT, UPDATE does not preserve a column exclusion, it
-- destroys it and rebuilds a WIDER surface than it found.
--
-- On user_vault_meta the excluded column is workspace_key_id, and it is load
-- bearing: every row level security policy on wrapped_data_keys decides who
-- owns a key by reading user_vault_meta.workspace_key_id. That column already
-- has a unique constraint and a write once trigger in front of it
-- (20260828214500). The missing column grant is a third, independent wall, and
-- the one that covers the FIRST write, which is the case the write once
-- trigger deliberately permits. Prod is already table wide here, so this file
-- does not regress prod; dev is the narrower of the two and that is the state
-- worth keeping rather than levelling down.
--
-- SELECT stays at table level on user_vault_meta on purpose. The policies
-- filter on the column, the client has to be able to read what it owns, and
-- reading an identifier is not writing it.
--
-- customer_vault_meta has no such exclusion: its live column ACLs are empty and
-- its table grants already equal this allow list, so a table wide grant there
-- is the accurate description of the intended surface, not a widening.
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
-- WHY keyring_ciphertext AND keyring_epoch ARE NOT NAMED BELOW. Read this before
-- "completing" the column lists, because adding them makes this file unappliable
-- to production.
--
-- Both columns are present on hosted dev and absent on hosted prod, which carries
-- 16 columns on this table. They reached dev out of band, with no file and no
-- ledger row behind them. The migrations that create them properly are
-- 20260831071500 (keyring_ciphertext) and 20260831120000 (keyring_epoch), and
-- both of those versions sort ABOVE this file's. Naming them here is a guaranteed
-- SQLSTATE 42703 on prod, which carries 16 columns, and a clean apply on dev,
-- which is the one environment that cannot catch it.
--
-- VERSION ORDER DOES NOT PROTECT THIS FILE. An earlier version of this header said
-- that it did, and that was wrong. Read the apply loop in
-- .github/workflows/supabase-deploy.yml: it selects pending files by SET
-- DIFFERENCE against the ledger and compares nothing against the highest applied
-- version. Version order is a total order WITHIN one apply run; it says nothing
-- across runs. A file that sorts below the ledger maximum is still applied the
-- first time it appears, so this file can and will run on a project that is
-- already ahead of it.
--
-- Measured on the dev project on 2026-09-02: the ledger holds no row for
-- 20260828163000, four higher versions are applied, and both keyring columns
-- already carry an authenticated column grant. So the next apply runs this file
-- against a table carrying two columns it does not know about.
--
-- Measured rather than argued, on a scratch pair of tables on the dev project,
-- 2026-09-02. The old 17 column form raised 42703, column "keyring_ciphertext"
-- does not exist, against a 16 column table shaped like prod, and applied clean
-- against an 18 column table shaped like dev.
--
-- SO THE RULE FOR THIS TABLE, which is the rule 20260831071500 already follows:
-- the migration that CREATES a column states that column's privilege. This file
-- states the privilege for the column set that exists at ITS version, 15 writable
-- columns with workspace_key_id excluded, and reaches forward to nothing.
--
-- WHAT MAKES THAT SAFE IS A SNAPSHOT, NOT AN ORDERING PROMISE. A table level
-- REVOKE ALL clears column ACLs, so the absolute REVOKE below would otherwise take
-- away a column grant made by a HIGHER numbered migration, and it would do it
-- silently: with the grant gone, every assertion in this file still passes,
-- because assertion 4b can only fire on a column that HAS a privilege it should
-- not have. On dev today that is exactly the keyring write path.
--
-- So before the REVOKE, this file records the column privileges authenticated
-- holds on user_vault_meta columns that are NOT in its own 16 column vocabulary,
-- and replays them after the GRANT. It states the privilege for the columns it
-- knows about and leaves every other column's grant exactly as it found it, on any
-- project, in any order. Re-running it by hand on a project ahead of it is safe.
-- Assertion 4b is scoped to match: a column this file preserved is not an
-- offender, and a column inside its own vocabulary still is.
--
-- Proved by execution on the dev project on 2026-09-02, on scratch tables in a
-- scratch schema that were dropped afterwards. Without the snapshot,
-- keyring_ciphertext and keyring_epoch came back attacl NULL with INSERT and
-- UPDATE false, and assertion 4b passed. With it, both kept authenticated=aw,
-- workspace_key_id stayed unwritable, assertion 3 still fired on a table wide
-- grant, assertion 4b still fired on a workspace_key_id grant, and a prod shaped
-- 16 column table applied clean with no 42703.
--
-- Idempotent. REVOKE and GRANT can be re-run. The assertions at the end fail
-- loudly rather than letting a partial apply look like a success.

-- user_vault_meta: per user vault salt, verifier and wrapped keys.
-- SELECT at table level; INSERT and UPDATE column scoped over the 15 columns
-- that exist at this version and that the member path writes, deliberately
-- excluding workspace_key_id. keyring_ciphertext and keyring_epoch are absent on
-- purpose: they do not exist at this version, and each is granted by the
-- migration that creates it. See the header.
-- Snapshot first. See the header: the REVOKE below is absolute and clears column
-- ACLs, and this file can run on a project that already carries columns granted by
-- a higher numbered migration. Everything authenticated holds on a column outside
-- this file's 16 column vocabulary is recorded here and replayed after the GRANT.
-- Only the three privileges in the allow list are carried over, so this cannot
-- reintroduce something assertion 2 would then reject.
DROP TABLE IF EXISTS pg_temp.uvm_preserved_column_grants;
CREATE TEMP TABLE uvm_preserved_column_grants AS
SELECT att.attname::text     AS column_name,
       a.privilege_type::text AS privilege_type,
       a.is_grantable         AS is_grantable
  FROM pg_attribute att
  CROSS JOIN LATERAL aclexplode(att.attacl) AS a
 WHERE att.attrelid = 'public.user_vault_meta'::regclass
   AND att.attnum > 0
   AND NOT att.attisdropped
   AND NOT (att.attname = ANY (ARRAY[
         'user_id',
         'vault_salt',
         'vault_verifier_ciphertext',
         'vault_key_version',
         'kdf_algorithm',
         'kdf_params',
         'created_at',
         'updated_at',
         'kem_public_key',
         'kem_secret_wrapped',
         'sig_public_key',
         'sig_secret_wrapped',
         'pqc_key_version',
         'enc_mek_ciphertext',
         'recovery_ciphertext',
         'workspace_key_id'
       ]))
   AND a.grantee = 'authenticated'::regrole
   AND a.privilege_type IN ('SELECT','INSERT','UPDATE');

ALTER TABLE public.user_vault_meta ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_vault_meta FROM PUBLIC;
REVOKE ALL ON TABLE public.user_vault_meta FROM anon;
REVOKE ALL ON TABLE public.user_vault_meta FROM authenticated;
GRANT SELECT ON TABLE public.user_vault_meta TO authenticated;
GRANT INSERT (
        user_id,
        vault_salt,
        vault_verifier_ciphertext,
        vault_key_version,
        kdf_algorithm,
        kdf_params,
        created_at,
        updated_at,
        kem_public_key,
        kem_secret_wrapped,
        sig_public_key,
        sig_secret_wrapped,
        pqc_key_version,
        enc_mek_ciphertext,
        recovery_ciphertext
      ),
      UPDATE (
        user_id,
        vault_salt,
        vault_verifier_ciphertext,
        vault_key_version,
        kdf_algorithm,
        kdf_params,
        created_at,
        updated_at,
        kem_public_key,
        kem_secret_wrapped,
        sig_public_key,
        sig_secret_wrapped,
        pqc_key_version,
        enc_mek_ciphertext,
        recovery_ciphertext
      )
  ON TABLE public.user_vault_meta TO authenticated;

-- Replay the grants this file did not make. On a project at or below this file's
-- version the snapshot is empty and this loop does nothing. privilege_type is
-- interpolated unquoted because it comes from the catalogue and the snapshot
-- restricts it to the three allow list values; the column name is quoted, because
-- it is a real identifier.
DO $$
DECLARE
  g record;
BEGIN
  FOR g IN SELECT * FROM uvm_preserved_column_grants LOOP
    EXECUTE format(
      'GRANT %s (%I) ON TABLE public.user_vault_meta TO authenticated%s',
      g.privilege_type,
      g.column_name,
      CASE WHEN g.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END;
$$;

-- customer_vault_meta: the same per customer, with no column exclusion.
ALTER TABLE public.customer_vault_meta ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.customer_vault_meta FROM PUBLIC;
REVOKE ALL ON TABLE public.customer_vault_meta FROM anon;
REVOKE ALL ON TABLE public.customer_vault_meta FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.customer_vault_meta TO authenticated;

-- Prove it, rather than assume the statements above did what they say.
--
-- These read pg_class.relacl and pg_attribute.attacl through aclexplode instead
-- of calling has_table_privilege with a fixed privilege list. That is
-- deliberate: a fixed list can only catch the privileges someone remembered to
-- name, and MAINTAIN is a recent addition that an older list would silently
-- skip. Asking the catalogue what is actually granted catches anything,
-- including a privilege that does not exist yet.
--
-- Every assertion below reads COLUMN ACLs as well as TABLE ACLs. An earlier
-- version of this file read table ACLs only, which meant a surviving column
-- grant to PUBLIC or anon would have passed it silently.
DO $$
DECLARE
  sealed_tables text[] := ARRAY[
    'public.user_vault_meta',
    'public.customer_vault_meta'
  ];
  -- The same 15 columns the GRANT above names, and the reason they are written
  -- twice rather than derived: see assertion 4. This list is the allow list, and
  -- assertion 4 checks it in both directions, so a name that appears in one place
  -- and not the other is caught rather than silently tolerated.
  member_writable_columns text[] := ARRAY[
    'user_id',
    'vault_salt',
    'vault_verifier_ciphertext',
    'vault_key_version',
    'kdf_algorithm',
    'kdf_params',
    'created_at',
    'updated_at',
    'kem_public_key',
    'kem_secret_wrapped',
    'sig_public_key',
    'sig_secret_wrapped',
    'pqc_key_version',
    'enc_mek_ciphertext',
    'recovery_ciphertext'
  ];
  offenders text;
BEGIN
  -- 1. PUBLIC and anon must hold nothing at all on either table, at table level
  --    or at column level.
  SELECT string_agg(x, ', ') INTO offenders FROM (
    SELECT DISTINCT t || ' TABLE ' || a.privilege_type || ' to ' ||
             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS x
      FROM unnest(sealed_tables) AS t
      JOIN pg_class c ON c.oid = t::regclass
      CROSS JOIN LATERAL aclexplode(c.relacl) AS a
     WHERE a.grantee = 0 OR a.grantee = 'anon'::regrole
    UNION ALL
    SELECT DISTINCT t || ' COLUMN ' || att.attname || ' ' || a.privilege_type || ' to ' ||
             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS x
      FROM unnest(sealed_tables) AS t
      JOIN pg_class c ON c.oid = t::regclass
      JOIN pg_attribute att
        ON att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped
      CROSS JOIN LATERAL aclexplode(att.attacl) AS a
     WHERE a.grantee = 0 OR a.grantee = 'anon'::regrole
  ) s;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'PUBLIC or anon still holds a privilege after the revoke block: %', offenders;
  END IF;

  -- 2. authenticated must hold nothing outside the allow list, at table level
  --    or at column level. Stated as "not in the allow list" rather than as a
  --    list of forbidden privileges, so a privilege nobody thought of is caught
  --    too.
  SELECT string_agg(x, ', ') INTO offenders FROM (
    SELECT DISTINCT t || ' TABLE ' || a.privilege_type AS x
      FROM unnest(sealed_tables) AS t
      JOIN pg_class c ON c.oid = t::regclass
      CROSS JOIN LATERAL aclexplode(c.relacl) AS a
     WHERE a.grantee = 'authenticated'::regrole
       AND a.privilege_type NOT IN ('SELECT','INSERT','UPDATE')
    UNION ALL
    SELECT DISTINCT t || ' COLUMN ' || att.attname || ' ' || a.privilege_type AS x
      FROM unnest(sealed_tables) AS t
      JOIN pg_class c ON c.oid = t::regclass
      JOIN pg_attribute att
        ON att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped
      CROSS JOIN LATERAL aclexplode(att.attacl) AS a
     WHERE a.grantee = 'authenticated'::regrole
       AND a.privilege_type NOT IN ('SELECT','INSERT','UPDATE')
  ) s;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'authenticated holds a privilege outside the allow list: %', offenders;
  END IF;

  -- 3. THE EXCLUSION. authenticated must not be able to write
  --    user_vault_meta.workspace_key_id by ANY route. has_column_privilege is
  --    used rather than a read of attacl because it answers the real question:
  --    it returns true for a table wide grant as well as a column grant, so it
  --    catches the exact regression this file was sent back to fix.
  --
  --    Why the column matters: every row level security policy on
  --    wrapped_data_keys reads this value to decide who owns a key. A unique
  --    constraint and a write once trigger already guard it; this is the wall
  --    in front of the first write, which the trigger permits by design.
  IF has_column_privilege('authenticated', 'public.user_vault_meta', 'workspace_key_id', 'INSERT')
     OR has_column_privilege('authenticated', 'public.user_vault_meta', 'workspace_key_id', 'UPDATE') THEN
    RAISE EXCEPTION
      'authenticated can write user_vault_meta.workspace_key_id, the owner identity exclusion is gone';
  END IF;

  -- 4. The member facing paths must still work, or this migration turned the
  --    policies into dead code and broke vault creation.
  --
  --    customer_vault_meta: all three at table level.
  SELECT string_agg('public.customer_vault_meta:' || p, ', ') INTO offenders
    FROM unnest(ARRAY['SELECT','INSERT','UPDATE']) AS p
   WHERE NOT has_table_privilege('authenticated', 'public.customer_vault_meta', p);
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'authenticated lost a privilege its policies need, the member path is broken on: %', offenders;
  END IF;

  --    user_vault_meta: SELECT at table level, plus INSERT and UPDATE on each
  --    column this file names and on NOTHING else. Both directions are checked,
  --    because each one catches a different mistake.
  --
  --    WHY THIS IS NO LONGER DERIVED FROM THE CATALOGUE. An earlier version read
  --    every live column and required all of them except workspace_key_id to be
  --    writable. That is a statement about whatever the table happens to look
  --    like on the project it lands on, so the same file passed on one and failed
  --    on another, and it silently tied this migration to columns created by
  --    files that sort ABOVE it. Probed on a scratch pair of tables on the dev
  --    project, 2026-09-02: with the reduced grant above, the catalogue form
  --    passed on a 16 column table and raised on an 18 column one, naming
  --    keyring_ciphertext and keyring_epoch. The fixed list is what makes this
  --    file say the same thing on every project.
  IF NOT has_table_privilege('authenticated', 'public.user_vault_meta', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated lost SELECT on public.user_vault_meta';
  END IF;

  --    4a. Every column this file grants must actually be writable. Catches a
  --    name dropped from the GRANT above, and also a name that is in the GRANT
  --    but not on the table, since has_column_privilege raises on a column that
  --    does not exist rather than answering false.
  SELECT string_agg(x.c || ':' || p, ', ') INTO offenders
    FROM unnest(member_writable_columns) AS x(c)
    CROSS JOIN unnest(ARRAY['INSERT','UPDATE']) AS p
   WHERE NOT has_column_privilege('authenticated', 'public.user_vault_meta', x.c, p);
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'authenticated cannot write a user_vault_meta column the member path needs: %', offenders;
  END IF;

  --    4b. Nothing outside that list may be writable, by any route. This is the
  --    half that makes the list above an allow list rather than a wish, and it is
  --    what a catalogue derived check could never state. has_column_privilege is
  --    used rather than a read of attacl because it answers true for a table wide
  --    grant as well as for a column grant, so a REVOKE followed by a table wide
  --    GRANT is caught here. Shown able to fail before being trusted: against a
  --    table wide GRANT SELECT, INSERT, UPDATE on the scratch table it reported
  --    workspace_key_id for both privileges.
  --
  --    A column the snapshot preserved is NOT an offender: this file did not grant
  --    it and does not claim to govern it. Without that exclusion the replay above
  --    would trip this assertion on any project ahead of this version. Everything
  --    inside the 16 column vocabulary is still checked, so workspace_key_id is
  --    still caught here as well as by assertion 3.
  SELECT string_agg(att.attname || ':' || p, ', ') INTO offenders
    FROM pg_attribute att
    CROSS JOIN unnest(ARRAY['INSERT','UPDATE']) AS p
   WHERE att.attrelid = 'public.user_vault_meta'::regclass
     AND att.attnum > 0
     AND NOT att.attisdropped
     AND NOT (att.attname = ANY(member_writable_columns))
     AND NOT EXISTS (
           SELECT 1 FROM uvm_preserved_column_grants k
            WHERE k.column_name = att.attname
              AND k.privilege_type = p)
     AND has_column_privilege('authenticated', att.attrelid, att.attname, p);
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'authenticated can write a user_vault_meta column outside the allow list: %', offenders;
  END IF;
END;
$$;

-- The snapshot is scaffolding for this one apply, not state. Drop it so a later
-- statement in the same session cannot read a stale copy.
DROP TABLE IF EXISTS pg_temp.uvm_preserved_column_grants;
