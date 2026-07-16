-- 20260716120000_client_platform_revoke_anon_grants.sql
-- Security fix. Author: Security. To be landed by: @DBA (migration lane).
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
--   (a) the hole is closed  -- anon cannot reach api_keys / audit_log / members
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
ALTER DEFAULT PRIVILEGES IN SCHEMA client_platform
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

-- 5. Prove it, in this transaction, or abort.
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
