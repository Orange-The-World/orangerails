-- 20260831100000_default_privileges_revoke_anon_execute_functions.sql
--
-- Take anon out of the DEFAULT privilege rule for functions in schema public,
-- so a newly created function does not arrive with anon EXECUTE already on it.
--
-- ============================================================================
-- OUT OF ORDER, AND WHY THAT IS SAFE FOR THIS PARTICULAR FILE
-- ============================================================================
-- OUT-OF-ORDER-OK: ALTER DEFAULT PRIVILEGES is forward looking only and this file touches no existing object, so applying it late is identical to applying it on time (OR-T1027).
--
-- The evidence for that one line, so a reviewer does not have to take it:
--
-- Version 20260831100000 is BELOW dev's highest applied ledger version, which
-- was 20260904150000 when this marker was written, and it is not on the
-- OUT_OF_ORDER_ALLOWLIST in .github/workflows/supabase-deploy.yml. Without this
-- marker the guard refuses the WHOLE apply run, not just this file, which is
-- the outage OR-T2256 was opened for. The marker is the route the DBA chose for
-- that class of file; renumbering was explicitly rejected.
--
-- Why late application is a no-op rather than a risk: the only statement in this
-- file is ALTER DEFAULT PRIVILEGES, which by definition affects objects created
-- AFTER it runs and never an object that already exists. There is therefore no
-- migration that could have run in between and be undone by this one, and no
-- ordering relationship to any other file. The verification block re-reads
-- pg_default_acl and RAISES on a wrong end state on every path, including the
-- already correct path, so a late run still asserts rather than assumes.
--
-- Written by orangeway/sp-1, who is not the DBA. If the DBA disagrees with this
-- assessment, remove these lines: the effect is that the migration stops being
-- mergeable until it is renumbered or allowlisted, not that anything unsafe
-- reaches a database.
--
-- ============================================================================
-- WHY THIS FILE EXISTS
-- ============================================================================
-- Every earlier fix in this family (20260721120000, 20260723190000,
-- 20260828160000, and the one-off hand-applied revoke on the vault trigger
-- functions) removed anon or PUBLIC EXECUTE from a LIST OF FUNCTIONS. Each was
-- correct on the day it landed. Each was then undone for the NEXT function
-- somebody created, because on the production project the default privilege
-- rule grants anon EXECUTE to every new function in schema public.
--
-- Measured 2026-08-31 by reading pg_default_acl on both hosted projects, for
-- schema public and defaclobjtype 'f':
--
--   dev  fzwmnzmtqidumdqjdddz
--     {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--   prod lcdicqalreskibdfxkzb
--     {anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--
-- Production includes anon. Dev does not. That one divergence is why this class
-- of finding keeps recurring on prod while dev keeps auditing clean: on prod,
-- creating a function IS granting anon EXECUTE on it.
--
-- ============================================================================
-- A CORRECTION TO AN EARLIER HEADER
-- ============================================================================
-- 20260828160000_revoke_public_execute_vault_trigger_functions.sql states:
--   "The default privilege rule for functions in public owned by postgres no
--    longer includes PUBLIC or anon, so this is a one time correction of an
--    existing set and not a recurring gap."
-- That is true on dev and false on prod. It was checked against one project. On
-- prod it is a recurring gap, and this file is what makes the original sentence
-- true everywhere rather than only where it was measured.
--
-- ============================================================================
-- WHAT THIS DOES, AND DOES NOT, DO
-- ============================================================================
-- DOES:     change the rule applied to functions created FROM NOW ON.
-- DOES NOT: change the ACL of a single function that already exists.
-- ALTER DEFAULT PRIVILEGES is forward looking only. Existing objects were
-- handled by the migrations named above and by the reviewed one-off revoke on
-- the vault trigger functions, so this file deliberately re-grants nothing and
-- revokes nothing on an existing object. Those are separate blast radii and
-- mixing them into one file is how a small change becomes an incident.
--
-- ============================================================================
-- THIS COVERS FUNCTIONS ONLY. TABLES AND SEQUENCES ARE NOT TOUCHED.
-- ============================================================================
-- Read this before reading a green run here as the default privilege problem
-- being closed. It is not. This file changes exactly one rule: default
-- privileges for FUNCTIONS in schema public, which is defaclobjtype 'f'.
--
-- The same mechanism also carries default privilege rules for TABLES ('r') and
-- SEQUENCES ('S') in schema public, and on the production project those rules
-- also hand anon access on every newly created object of those types. That is a
-- materially larger blast radius than the function case fixed here: a table
-- arrives readable, where a function only arrives callable.
--
-- Those two are deliberately NOT in this file, for the same reason the existing
-- object ACLs are not: a table or sequence default privilege change can take
-- read access away from a path that is currently working, so it needs its own
-- measurement, its own review and its own rollback, and mixing it in here is how
-- a small change becomes an incident. They are tracked separately.
--
-- So the correct reading of a green run of this migration is narrow: a function
-- created after it no longer arrives with anon EXECUTE. Nothing else changed.
--
-- ============================================================================
-- WHY "FOR ROLE postgres" IS WRITTEN OUT
-- ============================================================================
-- ALTER DEFAULT PRIVILEGES with no FOR ROLE clause binds to the role EXECUTING
-- the statement. That is an invisible dependency on who runs the migration: run
-- by a different role it would silently create a second, unrelated rule and
-- leave the real one untouched, and the migration would still report success.
-- The rule we measured is owned by postgres, so postgres is named explicitly.
-- 20260723170000_client_platform_revoke_anon_grants.sql documents the same trap.
--
-- ============================================================================
-- IDEMPOTENT, AND IT REFUSES TO PASS ON A WRONG END STATE
-- ============================================================================
-- Revoking a default privilege that is already absent is a no-op, so a re-run
-- changes nothing. The verification block at the end re-reads pg_default_acl and
-- RAISES if anon still holds EXECUTE in the rule. A migration that can report
-- success while having done nothing is the failure shape this codebase keeps
-- getting bitten by, so this one asserts its own end state rather than trusting
-- that the statement above it did what it said.
--
-- ON THE NO-OP CASE, since it differs from the one-off version of this work:
-- there is no "nothing to do, therefore fail" raise here, and that is deliberate
-- and is NOT the same decision as the one-off. In the one-off, revoking nothing
-- meant the target functions were missing and the run proved nothing. Here, the
-- desired end state is the ABSENCE of an anon entry in the rule, so a cluster
-- that already lacks it (dev) is already correct. Failing that case would abort
-- a legitimate fresh build for being right. The verification below still runs on
-- every path, so "already correct" is asserted, never assumed.
--
-- ============================================================================
-- REVERSIBLE, one line, run as postgres:
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     GRANT EXECUTE ON FUNCTIONS TO anon;
--
-- KNOWN CONSEQUENCE, stated so it is not a surprise later: after this, a
-- function that is genuinely meant to be callable by an anonymous browser
-- session needs an explicit GRANT EXECUTE ... TO anon in its own migration. That
-- is the intended outcome. An anon-callable function should be a decision
-- somebody wrote down, not a side effect of the schema it was created in.
--
-- WHAT THIS DOES NOT EXPLAIN, left open rather than guessed at: where the bare
-- PUBLIC (empty grantee) EXECUTE entries came from. They are not in either
-- project's default privilege rule, so they have a different source. The known
-- set was cleared by 20260828160000; the source is still unidentified.
-- ============================================================================

BEGIN;

DO $mig$
DECLARE
  v_before text;
  v_after  text;
BEGIN
  -- anon is a Supabase-managed role. On a cluster that does not have it there is
  -- nothing to revoke and nothing to verify, so skip loudly rather than fail.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'skipped: role anon does not exist on this cluster';
    RETURN;
  END IF;

  SELECT coalesce(d.defaclacl::text, 'NO-RULE')
    INTO v_before
    FROM pg_default_acl d
    JOIN pg_namespace n ON n.oid = d.defaclnamespace
   WHERE n.nspname = 'public'
     AND d.defaclobjtype = 'f'
     AND pg_get_userbyid(d.defaclrole) = 'postgres';

  RAISE NOTICE 'default privilege rule before: %', coalesce(v_before, 'NO-RULE');

  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    REVOKE EXECUTE ON FUNCTIONS FROM anon;

  SELECT coalesce(d.defaclacl::text, 'NO-RULE')
    INTO v_after
    FROM pg_default_acl d
    JOIN pg_namespace n ON n.oid = d.defaclnamespace
   WHERE n.nspname = 'public'
     AND d.defaclobjtype = 'f'
     AND pg_get_userbyid(d.defaclrole) = 'postgres';

  -- The rule row itself may disappear entirely if anon was the only non-default
  -- entry in it. That is a correct end state, not a failure, so NO-RULE passes
  -- the check below on its own terms.
  IF coalesce(v_after, 'NO-RULE') LIKE '%anon=%' THEN
    RAISE EXCEPTION
      'FAIL: anon still holds EXECUTE in the default privilege rule for functions in schema public. after=%',
      v_after;
  END IF;

  RAISE NOTICE 'default privilege rule after:  %', coalesce(v_after, 'NO-RULE');
  RAISE NOTICE 'verified: a newly created function in schema public will not carry anon EXECUTE';
END
$mig$;

COMMIT;