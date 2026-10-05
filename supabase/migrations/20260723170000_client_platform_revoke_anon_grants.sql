-- 20260723170000_client_platform_revoke_anon_grants.sql
-- Security fix. Author: Security. To be landed by: @DBA (migration lane).
--
-- VERSION NOTE. This file was previously numbered 20260716120000. That version is
-- already recorded on the dev ledger by discovery_sessions, and the runner skips a
-- file whose version is already present rather than erroring, so the earlier copy
-- would have read as applied without ever running. The number below was assigned by
-- the database steward against the live ledger. The DDL is byte for byte unchanged.
--
-- WHAT
-- Removes the blanket `anon` (unauthenticated PostgREST role) privileges in the
-- `client_platform` schema, keeping only the one surface anon is intended to read.
--
-- WHY
-- 20260531200000_client_platform_grants.sql authored TWO separate anon grants:
--     GRANT SELECT ON ALL TABLES IN SCHEMA client_platform TO anon;
--     ALTER DEFAULT PRIVILEGES IN SCHEMA client_platform GRANT SELECT ON TABLES TO anon;
-- The first covers the 8 tables that existed at that moment. The second silently
-- grants anon SELECT on every table added to this schema from then on, forever.
-- No migration has ever revoked either one: `client_platform` appears in only 3 of
-- 86 migration files (schema, grants, a key_hash type change), and every REVOKE
-- hardening migration in this repo targets `public`, never `client_platform`.
-- The catalog independently confirms this: anon still holds `r` on all 8 tables.
--
-- Row Level Security is currently the ONLY control standing between the
-- unauthenticated role and every table in this schema, including:
--     client_platform.api_keys   (key_hash)
--     client_platform.audit_log  (actor_email, client_ip -- PII)
--
-- CURRENT EXPOSURE: NONE. Verified by reading the policy quals, not assumed.
-- Every policy in this schema is scoped to {authenticated} except
-- api_plans.plans_public_read ({anon,authenticated}, USING (active = true)), which
-- is intended public pricing. RLS therefore default-denies anon everywhere else.
--
-- THIS IS A LANDMINE FIX, NOT AN INCIDENT RESPONSE.
-- It is functionally inert today: it removes privileges that currently grant nothing
-- anon can reach. It matters for what comes next. A future table added to this schema
-- inherits anon SELECT by default, and if it ships without ENABLE ROW LEVEL SECURITY
-- it is world-readable the instant it is created -- with no migration, review, or log
-- line saying so. This removes the default so that mistake cannot happen silently.
--
-- SCOPE DISCIPLINE: this migration touches `anon` only. The separate question of
-- `authenticated` holding blanket arwd on all 8 tables is real but distinct, is
-- currently gated by identity-scoped policies on every table, and is deliberately
-- NOT bundled here. Filed as follow-up.
--
-- SAFETY: idempotent, transactional, and self-proving. The assertion block asserts
-- BOTH directions in the same transaction and ABORTS on failure:
--   (a) the hole is closed  -- anon cannot reach ANY of the 7 revoked tables, each
--                              pinned by name, because this block is the only proof
--                              that runs at apply time
--   (b) nothing broke       -- anon KEEPS public pricing; authenticated KEEPS the
--                              membership helpers every RLS policy here depends on.
--
-- !! NOTE FOR WHOEVER APPLIES THIS !!
-- ALTER DEFAULT PRIVILEGES with no FOR ROLE clause binds to the role EXECUTING the
-- statement. The existing default ACL in this schema is owned by `postgres`
-- (pg_default_acl.defaclrole = postgres). This migration MUST run as `postgres` or
-- step 1 silently no-ops and the default grant survives. The assertion block cannot
-- catch that, because default privileges only bite on tables created later. Verify
-- after applying:
--     SELECT d.defaclobjtype, d.defaclacl::text
--       FROM pg_default_acl d
--       JOIN pg_namespace n ON n.oid = d.defaclnamespace
--      WHERE n.nspname = 'client_platform';
-- and confirm `anon` is ABSENT from the TABLES ('r') row.

BEGIN;

-- 1. Future tables in this schema must not inherit anon SELECT. This is the
--    actual point of the migration.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA client_platform
  REVOKE SELECT ON TABLES FROM anon;

-- 2. Drop the standing blanket grant on the tables that already exist.
REVOKE SELECT ON ALL TABLES IN SCHEMA client_platform FROM anon;

-- 3. Re-grant the single intended anon surface: public pricing.
--    Preserves the existing api_plans.plans_public_read policy (USING (active = true)).
GRANT SELECT ON client_platform.api_plans TO anon;

-- 4. anon does not need EXECUTE on the membership helpers.
--    Both are SECURITY DEFINER. Both are correctly built -- search_path is pinned,
--    and each gates on `user_id = auth.uid()`, which is NULL for anon, so they
--    already return false. This is defence in depth, NOT a fix for a live bug.
--    Both also carry an EXECUTE grant to PUBLIC, which anon inherits, so revoking
--    from anon alone would leave that path open. Revoke PUBLIC too.
--    `authenticated` and `service_role` hold their own explicit grants and are
--    unaffected -- asserted below, because every RLS policy here calls these.
REVOKE EXECUTE ON FUNCTION client_platform.is_member_of(uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION client_platform.has_role(uuid, text) FROM anon, PUBLIC;

-- 5. Remove all anon privileges on public.data_keys.
--    data_keys inherits INSERT, SELECT, UPDATE and DELETE from the public-schema default
--    table ACL (pg_default_acl objtype=r, acl=anon=arwd/postgres). RLS is enabled and
--    the only policy scopes to authenticated, so anon cannot reach any row today.
--    Removing all four grants ensures a future permissive policy on this table cannot
--    turn them live without a migration and review. Placed here (file 4) per CTO ruling;
--    file 5 does not duplicate it.
--
--    GUARD (OR-T2231, CTO ruling on OR-T2230). This file is numbered four days before
--    20260727000000_data_keys_ownership_and_rotate_authz.sql, which is what creates
--    public.data_keys. dev and prod both already applied this file successfully because
--    history was not replayed in strict filename order (table already existed by the time
--    this ran). A from-scratch replay in filename order reaches this line before the table
--    exists and REVOKE would fail with 42P01. Guarded so that case skips cleanly instead;
--    an environment where the table already exists is unaffected, byte for byte.
DO $data_keys_revoke$
BEGIN
  IF to_regclass('public.data_keys') IS NULL THEN
    RAISE NOTICE 'public.data_keys does not exist yet on this database (fresh bootstrap before 20260727000000), skipping REVOKE';
  ELSE
    REVOKE ALL ON public.data_keys FROM anon;
  END IF;
END
$data_keys_revoke$;

-- 6. Prove it, in this transaction, or abort.
--    (a) covers all 7 tables step 2 must close, each named. The schema holds 8
--    tables and every one of them carries an anon SELECT entry; api_plans is
--    deliberately re-granted at step 3, so 7 must end with none. Named, not
--    counted: a count passes silently when a table is added, swapped or dropped.
--    The 2 sequences in this schema carry no anon entry and are out of scope.
DO $$
BEGIN
  -- (a) the hole is closed
  IF has_table_privilege('anon', 'client_platform.api_keys', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL: anon still holds SELECT on client_platform.api_keys';
  END IF;
  IF has_table_privilege('anon', 'client_platform.audit_log', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL: anon still holds SELECT on client_platform.audit_log';
  END IF;
  IF has_table_privilege('anon', 'client_platform.organization_members', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL: anon still holds SELECT on client_platform.organization_members';
  END IF;
  IF has_table_privilege('anon', 'client_platform.api_usage', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL: anon still holds SELECT on client_platform.api_usage';
  END IF;
  IF has_table_privilege('anon', 'client_platform.applications', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL: anon still holds SELECT on client_platform.applications';
  END IF;
  IF has_table_privilege('anon', 'client_platform.organization_entitlements', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL: anon still holds SELECT on client_platform.organization_entitlements';
  END IF;
  IF has_table_privilege('anon', 'client_platform.organizations', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL: anon still holds SELECT on client_platform.organizations';
  END IF;

  -- (c) step 5: all four anon grants on public.data_keys are gone. Guarded the same
  --     way as the REVOKE above: only checked when the table exists on this database,
  --     so a from-scratch replay before 20260727000000 does not 42P01 here either.
  IF to_regclass('public.data_keys') IS NOT NULL THEN
    IF has_table_privilege('anon', 'public.data_keys', 'SELECT')
       OR has_table_privilege('anon', 'public.data_keys', 'INSERT')
       OR has_table_privilege('anon', 'public.data_keys', 'UPDATE')
       OR has_table_privilege('anon', 'public.data_keys', 'DELETE') THEN
      RAISE EXCEPTION 'FAIL: anon still holds privileges on public.data_keys';
    END IF;
  END IF;

  -- (b) nothing broke
  IF NOT has_table_privilege('anon', 'client_platform.api_plans', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL: anon lost SELECT on client_platform.api_plans -- public pricing read would break';
  END IF;
  IF NOT has_function_privilege('authenticated', 'client_platform.is_member_of(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: authenticated lost EXECUTE on is_member_of -- every RLS policy in this schema would deny';
  END IF;
  IF NOT has_function_privilege('authenticated', 'client_platform.has_role(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: authenticated lost EXECUTE on has_role -- admin/owner RLS policies would deny';
  END IF;
END $$;

COMMIT;
