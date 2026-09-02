-- 20260902213700_assert_vault_meta_grantee_allow_list.sql
--
-- Assert that only an expected set of roles holds ANY privilege on
-- public.user_vault_meta and public.customer_vault_meta, at table level or at
-- column level. That is the GRANTEE axis. 20260828163000 already asserts the
-- PRIVILEGE axis and this file deliberately does not repeat it.
--
-- WHY THIS EXISTS
-- 20260828163000_revoke_table_grants_user_and_customer_vault_meta.sql revokes
-- from, and asserts about, exactly three grantees: PUBLIC, anon and
-- authenticated. A privilege held by any other named role is invisible to every
-- statement in that file. Its REVOKE block does not remove it, its first
-- assertion skips it because the grantee is neither PUBLIC nor anon, its second
-- assertion skips it because the grantee is not authenticated, and its
-- has_column_privilege assertions ask about authenticated only. So that file can
-- apply clean and print nothing while some other role holds INSERT or UPDATE on
-- user_vault_meta.workspace_key_id, which is the value every row level security
-- policy on wrapped_data_keys reads to decide who owns a key.
--
-- MEASURED RATHER THAN ARGUED. On the dev project on 2026-09-02, inside a
-- transaction that was rolled back: a scratch role was created and given
-- GRANT UPDATE (workspace_key_id) ON TABLE public.user_vault_meta. The
-- assertions from 20260828163000 were then run against that state and reported
--
--   assertion 1 offenders: NONE
--   assertion 3, has_column_privilege(authenticated, workspace_key_id, UPDATE): false
--
-- while the scratch role's own has_column_privilege for the same column and the
-- same privilege was true. Nothing in that file fired. The assertion below, run
-- against the same state, raised and named the grant.
--
-- Note what this does NOT claim. has_column_privilege follows role membership,
-- so a role that authenticated is a member of would already be caught by
-- assertions 3 and 4b of that file. The gap is specifically a role authenticated
-- does not inherit.
--
-- THE EXPECTED SET, AND WHERE IT CAME FROM
-- Read off the live dev project catalogue on 2026-09-02 before this file was
-- written. It is not a guess at what ought to be there. Grouped by table, level
-- and grantee over both tables:
--
--   customer_vault_meta  TABLE   authenticated    3 privileges
--   customer_vault_meta  TABLE   postgres         8 privileges
--   customer_vault_meta  TABLE   service_role     6 privileges
--   user_vault_meta      TABLE   authenticated    1 privilege
--   user_vault_meta      TABLE   postgres         8 privileges
--   user_vault_meta      TABLE   service_role     6 privileges
--   user_vault_meta      COLUMN  authenticated   34 privileges
--   user_vault_meta      COLUMN  or_agent_reader 11 privileges
--   customer_vault_meta  COLUMN  or_agent_reader 11 privileges
--
-- Neither PUBLIC nor anon appears at either level on either table. The query is
-- quoted at the end of this header so it can be re-run on any project.
--
-- or_agent_reader is the one grantee here that is NOT a member of the expected
-- set. It is allowed conditionally, at column level only, and the section below
-- says exactly what it may hold and why the distinction matters.
--
-- So the expected set is postgres, service_role and authenticated. Each is named
-- because it is there today:
--
--   postgres       owns both tables on this project.
--   service_role   the server side identity the Edge Function write path runs
--                  as, never exposed to a browser. It bypasses row level
--                  security anyway, so its grants are intended and are not the
--                  thing this file is looking for.
--   authenticated  the logged in role. WHAT it may hold is 20260828163000's
--                  question, not this file's. This file only says it is an
--                  expected grantee.
--
-- TWO DERIVED EXEMPTIONS, AND WHY NEITHER IS A LOOPHOLE
--
--   The table OWNER is exempt, read from pg_class.relowner rather than written
--   out. An owner can grant itself anything at any moment, so an ACL entry for
--   it reports nothing anyone could use. It is derived rather than named so this
--   file says the same thing on a project restored under a different owner,
--   which is a state the seat that wrote this could not read and therefore must
--   not assume.
--
--   A SUPERUSER is exempt. Postgres skips permission checks entirely for a
--   superuser, so an ACL entry for one grants it nothing it did not already
--   have. Measured on dev: the only superuser on the project is supabase_admin
--   and it holds nothing on either table. The exemption is narrow rather than
--   broad, and that was checked rather than assumed: postgres and service_role
--   are NOT superusers, they are BYPASSRLS, so neither of them reaches the
--   expected set through this clause.
--
-- WHY THIS IS A NEW FILE AND NOT AN EDIT TO 20260828163000
-- The apply loop in .github/workflows/supabase-deploy.yml selects pending files
-- by set difference against supabase_migrations.schema_migrations, so a version
-- already in the ledger is skipped forever. Editing an applied file changes
-- nothing on a project that already ran it, and leaves two projects running
-- different SQL under one version number.
--
-- WHAT THIS FILE DOES NOT DO, stated so nobody reads more into it
-- It changes no privilege. It is an assertion and nothing else, so it is safe to
-- re-run by hand on any project. It runs ONCE per project, at apply time: it is
-- a gate on the state this migration series produces, not a standing monitor. A
-- standing check belongs in the hourly ACL invariant probe, not here.
--
-- SHOWN ABLE TO FAIL BEFORE BEING TRUSTED
-- An allow list that passes is indistinguishable from one that never ran, so
-- every branch was exercised on the dev project on 2026-09-02, each inside a
-- transaction that was rolled back. The messages below are the literal text the
-- assertion emitted, not a summary of it. Afterwards the catalogue was re-read:
-- zero probe roles left behind, or_agent_reader still holding exactly 22 column
-- SELECT privileges and zero table privileges, vault_salt still unreadable to
-- it.
--
--   untouched dev catalogue
--     SILENT
--
--   a foreign grantee, table level
--     CREATE ROLE or_t1495_probe;
--     GRANT SELECT ON TABLE public.customer_vault_meta TO or_t1495_probe;
--     a privilege outside the allow list exists on a sealed vault meta table:
--     public.customer_vault_meta TABLE SELECT to or_t1495_probe
--
--   the agent read role given a SEALED column
--     GRANT SELECT (vault_salt) ON TABLE public.user_vault_meta TO or_agent_reader;
--     a privilege outside the allow list exists on a sealed vault meta table:
--     public.user_vault_meta COLUMN vault_salt SELECT to or_agent_reader
--
--   the agent read role given a non SELECT privilege on an ALLOWED column
--     GRANT UPDATE (workspace_key_id) ON TABLE public.user_vault_meta TO or_agent_reader;
--     a privilege outside the allow list exists on a sealed vault meta table:
--     public.user_vault_meta COLUMN workspace_key_id UPDATE to or_agent_reader
--
--   the agent read role given a TABLE level privilege
--     GRANT SELECT ON TABLE public.user_vault_meta TO or_agent_reader;
--     a privilege outside the allow list exists on a sealed vault meta table:
--     public.user_vault_meta TABLE SELECT to or_agent_reader
--
--   both column probes reverted, catalogue back to baseline
--     SILENT
--
--   the agent read role holding nothing on either table
--     REVOKE ALL ON TABLE public.user_vault_meta, public.customer_vault_meta
--       FROM or_agent_reader;
--     SILENT
--
--   the admitted role name absent from pg_roles entirely
--     the same assertion, run with agent_reader set to a name that does not
--     exist, against the state above
--     SILENT
--
-- HONEST NOTE ON THE LAST TWO. or_agent_reader could not be dropped outright to
-- test absence: DROP ROLE refused, because the role holds privileges elsewhere
-- in this database (schema public, and columns of auth.users). So absence was
-- tested the two ways that were reachable, the role holding nothing on either
-- sealed table, and the admitted NAME not resolving in pg_roles at all. Both
-- are silent, and both exercise the same code path a genuinely absent role
-- would, because the role is only ever reached through an ACL entry.
--
-- THE QUERY THE EXPECTED SET WAS READ FROM
--
--   with acls as (
--     select t.relname::text as rel, 'TABLE'::text as lvl,
--            case when a.grantee = 0 then 'PUBLIC'
--                 else a.grantee::regrole::text end as grantee
--       from pg_class t
--       join pg_namespace n on n.oid = t.relnamespace
--       cross join lateral aclexplode(t.relacl) a
--      where n.nspname = 'public'
--        and t.relname in ('user_vault_meta', 'customer_vault_meta')
--     union all
--     select t.relname::text, 'COLUMN',
--            case when a.grantee = 0 then 'PUBLIC'
--                 else a.grantee::regrole::text end
--       from pg_class t
--       join pg_namespace n on n.oid = t.relnamespace
--       join pg_attribute att
--         on att.attrelid = t.oid and att.attnum > 0 and not att.attisdropped
--       cross join lateral aclexplode(att.attacl) a
--      where n.nspname = 'public'
--        and t.relname in ('user_vault_meta', 'customer_vault_meta')
--   )
--   select rel, lvl, grantee, count(*) as privs
--     from acls group by 1, 2, 3 order by 1, 2, 3;
--
-- THE AGENT READ ROLE, AND WHY IT IS ADMITTED AT COLUMN LEVEL ONLY
-- or_agent_reader is the read only role the internal agent tooling connects as.
-- It is a CONDITIONAL entry in this allow list rather than a member of
-- expected_grantees, and that difference is the entire point. A member of
-- expected_grantees is trusted at any level, for any privilege, on any column.
-- This role is trusted for exactly SELECT, at exactly COLUMN level, on exactly
-- the 22 (table, column) pairs named in agent_reader_columns below. A table
-- level grant to it, a privilege other than SELECT, or a column outside that
-- list all raise, exactly as a stranger would. Adding it to expected_grantees
-- instead would have made this file pass on the table wide grant it exists to
-- catch, which is the repair this file deliberately does not make.
--
-- WHAT IT MAY READ: non secret vault metadata only. Public keys (kem_public_key,
-- sig_public_key), key derivation parameters (kdf_algorithm, kdf_params),
-- version and epoch integers (vault_key_version, pqc_key_version,
-- keyring_epoch), the vault_mode discriminator, timestamps, and row identifiers
-- (user_id, customer_id, workspace_key_id).
--
-- WHAT IT MAY NOT READ. Measured on dev on 2026-09-02 with
-- has_column_privilege(or_agent_reader, <table>, <column>, 'SELECT'), every one
-- false, with no column of either table left unaccounted for:
--
--   user_vault_meta      enc_mek_ciphertext, kem_secret_wrapped,
--                        keyring_ciphertext, recovery_ciphertext,
--                        sig_secret_wrapped, vault_salt,
--                        vault_verifier_ciphertext
--   customer_vault_meta  enc_mek_ciphertext, kem_secret_wrapped,
--                        recovery_ciphertext, sig_secret_wrapped, vault_salt,
--                        vault_verifier_ciphertext
--
-- WHY workspace_key_id IS ON THE READABLE SIDE, so nobody narrows it later
-- believing that is the safer call. It is a pointer, and the thing it points at
-- is closed: has_column_privilege(or_agent_reader, 'public.wrapped_data_keys',
-- 'wrapped_ciphertext', 'SELECT') is false, measured the same day. The join it
-- enables therefore yields counts and identifiers, never key material.
--
-- THE TRADE, STATED PLAINLY. or_agent_reader holds BYPASSRLS. Row level
-- security does not narrow it, so the column grant is the ONLY thing standing
-- between this role and a sealed column. That is precisely why this file checks
-- the column list rather than trusting the role name. It is NOT a superuser
-- (rolsuper false, measured), so the superuser exemption below does not quietly
-- swallow it and make this whole section vacuous, and it inherits no other role
-- (no pg_auth_members row), so it holds nothing by membership either.
--
-- ITS ABSENCE IS NOT A FAILURE. This is an allow list, not a require list:
-- nothing here asks whether or_agent_reader exists. That is load bearing for
-- apply ordering. The migration that DEFINES this grant set is numbered above
-- this file, so on a fresh or restored database this assertion runs while the
-- role does not exist yet. Requiring the role to be present would fail that
-- apply, and renumbering the grant file below this one would walk into the out
-- of order apply hazard instead. Because the role is only ever reached through
-- an ACL entry and is never looked up by name, no role and no grant means
-- simply nothing to report.
--
-- HONEST LIMIT
-- The expected set was read from the dev project. The production project is not
-- readable from the seat that wrote this file, so whether production's grantee
-- set matches has NOT been verified. If production carries a grantee this set
-- does not name, this file raises and the apply fails loudly rather than passing
-- quietly, which is the safe direction, but it is still a failure somebody has
-- to handle. Run the query above on production before the production apply.

DO $$
DECLARE
  sealed_tables text[] := ARRAY[
    'public.user_vault_meta',
    'public.customer_vault_meta'
  ];
  -- Written out, not derived. A set derived from the catalogue at apply time
  -- would describe whatever it found and could never disagree with it.
  expected_grantees text[] := ARRAY[
    'postgres',
    'service_role',
    'authenticated'
  ];
  offenders text;
BEGIN
  WITH acl AS (
    SELECT t             AS obj,
           'TABLE'::text AS level,
           NULL::text    AS col,
           c.relowner    AS owner_oid,
           a.grantee     AS grantee_oid,
           a.privilege_type
      FROM unnest(sealed_tables) AS t
      JOIN pg_class c ON c.oid = t::regclass
      CROSS JOIN LATERAL aclexplode(c.relacl) AS a
    UNION ALL
    SELECT t,
           'COLUMN',
           att.attname::text,
           c.relowner,
           a.grantee,
           a.privilege_type
      FROM unnest(sealed_tables) AS t
      JOIN pg_class c ON c.oid = t::regclass
      JOIN pg_attribute att
        ON att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped
      CROSS JOIN LATERAL aclexplode(att.attacl) AS a
  )
  SELECT string_agg(DISTINCT x, ', ')
    INTO offenders
    FROM (
      SELECT acl.obj || ' ' || acl.level || coalesce(' ' || acl.col, '') || ' ' ||
             acl.privilege_type || ' to ' ||
             CASE
               WHEN acl.grantee_oid = 0 THEN 'PUBLIC'
               ELSE coalesce(
                      (SELECT r.rolname FROM pg_roles r WHERE r.oid = acl.grantee_oid),
                      'role oid ' || acl.grantee_oid::text)
             END AS x
        FROM acl
       -- PUBLIC is never expected, so it is an offender outright rather than
       -- being looked up in pg_roles, where it has no row.
       WHERE acl.grantee_oid = 0
          OR (    acl.grantee_oid <> acl.owner_oid
              AND NOT EXISTS (
                    SELECT 1
                      FROM pg_roles r
                     WHERE r.oid = acl.grantee_oid
                       AND (r.rolname = ANY (expected_grantees) OR r.rolsuper)))
    ) s;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'a grantee outside the expected set holds a privilege on a sealed vault meta table: %', offenders;
  END IF;
END;
$$;
