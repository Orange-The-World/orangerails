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
--
-- Neither PUBLIC nor anon appears at either level on either table, and no other
-- role appears at all. The query is quoted at the end of this header so it can
-- be re-run on any project.
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
-- On the dev project on 2026-09-02, each probe inside a transaction that was
-- rolled back, with no role left behind afterwards (pg_roles re-read: zero):
--
--   table level   CREATE ROLE ...; GRANT SELECT ON TABLE public.user_vault_meta
--                 raised: a grantee outside the expected set holds a privilege
--                 on a sealed vault meta table: public.user_vault_meta TABLE
--                 SELECT to or_t1469_probe
--
--   column level  CREATE ROLE ...; GRANT UPDATE (workspace_key_id) ON TABLE
--                 public.user_vault_meta
--                 raised: a grantee outside the expected set holds a privilege
--                 on a sealed vault meta table: public.user_vault_meta COLUMN
--                 workspace_key_id UPDATE to or_t1469_probe
--
-- Run unmodified against the untouched dev catalogue, it passed.
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
