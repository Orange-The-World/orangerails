-- 20260828133000_close_default_grants_public_tables_sequences_authenticated.sql
--
-- DEV-0241 / DEV-0220 (CTO ruling, option C). Closes the rest of the schema public
-- default privilege surface that migration 20260825120000 (DL-1749, PR #886) did not
-- cover: tables, sequences, and the authenticated role on functions.
--
-- VERSION NOTE. Originally filed as 20260828130000 on PR #941. Renamed to 20260828133000
-- because PR #925 already carries 20260828130000 (DEV-0322). No SQL change.
--
-- WHAT THIS DOES AND DOES NOT DO. ALTER DEFAULT PRIVILEGES only changes what a FUTURE
-- object created by role postgres inherits. It touches zero existing tables, sequences
-- or functions, drops nothing and moves no data. It is a two way door: re-issuing the
-- matching GRANT form restores the previous default exactly.
--
-- WHY FOR ROLE postgres ONLY. pg_has_role('postgres','supabase_admin','MEMBER') is FALSE
-- on both dev and prod (verified live on DEV-0226). The supabase_admin-granted default
-- ACL row for (public, functions) is not writable by any role we hold, on either
-- project. An assertion or a REVOKE aimed at that row can only abort the way
-- 20260825120000 did before it was scoped. Every check below is therefore scoped to
-- defaclrole = 'postgres'. Coverage of the supabase_admin row is DL-1776 (the anon-RPC
-- CI gate), tracked separately; it is a future tap today, not a live hole (DEV-0226: no
-- function in public is currently supabase_admin-owned on either project).
--
-- WHO CONNECTS AS postgres. Verified this wake: the apply-migrations CI job
-- (.github/workflows/supabase-deploy.yml) applies every migration through the Supabase
-- Management API (POST /v1/projects/{ref}/database/query, authenticated by
-- SUPABASE_ACCESS_TOKEN, no DB password). Empirically, every object created by a
-- migration that ran through this exact job carries grantor postgres in its
-- pg_default_acl / owner in pg_class: the four org vault tables created by
-- 20260815000001 and revoked by 20260828120000 show postgres throughout, read live on
-- dev. If migrations executed as any other role, those rows would name that role
-- instead. FOR ROLE postgres is therefore the role that actually matters for every
-- object this pipeline creates.
--
-- ENUMERATION, DEV-0220's second precondition ("enumerate the anon-callable and
-- authenticated-callable RPCs relying on the default; do not assume there are none").
-- Queried live on dev, 2026-08-28:
--   select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public' and array_to_string(p.proacl,',') ilike '%anon%';
--   -- 0 rows.
--   select count(*) filter (where proacl is null) from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public';
--   -- 0 of 50: every function in public already carries an explicit ACL. None is
--   -- silently riding the default for anon or authenticated today.
-- No equivalent enumeration is possible for tables, and none is needed for the same
-- reason existing objects are untouched: only a table created AFTER this migration
-- lands could ever rely on the closed default, and none exists yet. The accepted risk,
-- named in the DEV-0220 ruling, is that the next migration creating a table or RPC
-- meant for anon or authenticated must carry its own explicit GRANT, or it fails loudly
-- in dev, which is the trade the ruling takes deliberately over a silent prod opening.
--
-- Idempotent. Both the REVOKE statements and the assertion below can be re-run.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;

-- Prove it, scoped to the postgres grantor row only. aclexplode rather than a text
-- match on defaclacl, so this cannot be fooled by a role name that happens to be a
-- substring of another (there is no such collision here, but the explode is the
-- correct primitive regardless).
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(format('%s:%s', d.defaclobjtype, a.grantee::regrole::text), ', '
                     ORDER BY d.defaclobjtype, a.grantee::regrole::text)
    INTO offenders
    FROM pg_default_acl d
    JOIN pg_namespace n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a
   WHERE n.nspname = 'public'
     AND d.defaclrole = 'postgres'::regrole
     AND d.defaclobjtype IN ('r', 'S', 'f')
     AND a.grantee::regrole::text IN ('anon', 'authenticated');

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'postgres default privileges in public still reach anon or authenticated on: %', offenders;
  END IF;
END;
$$;
