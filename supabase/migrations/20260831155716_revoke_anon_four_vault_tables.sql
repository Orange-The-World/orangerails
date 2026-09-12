-- 20260831155716_revoke_anon_four_vault_tables.sql
--
-- WHAT THIS CHANGES
--   Removes the table level grant held by the anonymous role, and any grant held
--   by PUBLIC, on the four vault tables that PR #1038 deliberately deferred:
--     customer_recovery_shares, opk_key_rotations, platform_key_audit,
--     vault_security_events
--   PR #1038 does the same for user_vault_meta and customer_vault_meta. Together
--   the two cover the six tables measured as carrying an anon grant.
--
-- WHY NOW
--   All four carry anon = arwd, which includes DELETE. That is strictly worse
--   than the two tables #1038 covers, which are arw. These tables hold recovery
--   shares, key rotation records, key audit rows and vault security events.
--
-- WHY PUBLIC IS REVOKED ALONGSIDE anon
--   Revoking only anon can leave a bare PUBLIC entry behind, which every role
--   inherits, so the hole stays open while the obvious check reads clean. On the
--   clusters measured on 2026-08-31 there is no PUBLIC entry on these four, so
--   this half is a no-op there and is present so the file states the whole rule
--   rather than the half that happened to be true that day.
--
-- WHY THIS IS SAFE, read live off production on 2026-08-31 before writing this
--   RLS is enabled on all four. No policy on any of the four admits the
--   anonymous role. customer_recovery_shares has 3 policies and
--   vault_security_events has 2, all naming authenticated only.
--   opk_key_rotations and platform_key_audit have ZERO policies, which under RLS
--   is deny all for a non owner role. So the anonymous role reaches zero rows
--   today with the grants still in place: nothing can currently be succeeding
--   through this grant, so nothing can break when it is removed.
--
-- CAN IT BE UNDONE
--   Yes, and the exact statements are:
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_recovery_shares TO anon;
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.opk_key_rotations       TO anon;
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_key_audit      TO anon;
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vault_security_events   TO anon;
--   That restores the state recorded on 2026-08-31 (anon = arwd on each). No
--   data is touched by this migration, so there is nothing to restore beyond the
--   grants themselves.
--
-- IS IT IDEMPOTENT
--   Yes. REVOKE on a privilege that is already absent is a no-op, so a re-run
--   changes nothing and cannot wedge. The assert block below is also safe to
--   re-run: it only reads the catalog.
--
-- LOCKING
--   REVOKE takes a lock on the table's catalog entry only. It does not scan or
--   rewrite rows, so it is momentary regardless of table size.
--
-- SCOPE, stated so the next reader does not think it was missed
--   The authenticated role also holds DELETE on all four, and UPDATE on
--   vault_security_events, with NO policy backing either. That is the same class
--   of finding one role over. It is deliberately NOT in this migration, to keep
--   one scoped concern per change, and it is filed on its own ticket.

-- Step 1. Revoke, counting what was actually processed so that a run which
-- processed nothing cannot report success by reaching the end.
DO $revoke$
DECLARE
  v_tables  text[] := ARRAY[
    'customer_recovery_shares',
    'opk_key_rotations',
    'platform_key_audit',
    'vault_security_events'
  ];
  v_t       text;
  v_done    integer := 0;
  v_expected integer := 4;
BEGIN
  IF array_length(v_tables, 1) <> v_expected THEN
    RAISE EXCEPTION 'refusing to run: the table list holds % entries, expected %',
      array_length(v_tables, 1), v_expected;
  END IF;

  FOREACH v_t IN ARRAY v_tables LOOP
    IF to_regclass('public.' || quote_ident(v_t)) IS NULL THEN
      RAISE EXCEPTION 'refusing to continue: public.% does not exist on this cluster, so this migration cannot claim to have secured it', v_t;
    END IF;

    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', v_t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', v_t);
    v_done := v_done + 1;
  END LOOP;

  IF v_done <> v_expected THEN
    RAISE EXCEPTION 'assert failed: revoked on % table(s), expected %', v_done, v_expected;
  END IF;

  RAISE NOTICE 'revoked anon and PUBLIC on % of % vault table(s)', v_done, v_expected;
END
$revoke$;

-- Step 2. Prove the post state, per table, rather than trusting step 1 to have
-- worked. This block is written so it CAN fail: it names what it found, and it
-- also checks that the revoke did NOT overshoot and remove the grants the
-- application actually runs on.
DO $assert$
DECLARE
  v_tables text[] := ARRAY[
    'customer_recovery_shares',
    'opk_key_rotations',
    'platform_key_audit',
    'vault_security_events'
  ];
  v_t        text;
  v_checked  integer := 0;
  v_anon     integer;
  v_public   integer;
  v_service  integer;
  v_authed   integer;
BEGIN
  FOREACH v_t IN ARRAY v_tables LOOP
    SELECT
      count(*) FILTER (WHERE a.grantee = 'anon'::regrole),
      count(*) FILTER (WHERE a.grantee = 0),
      count(*) FILTER (WHERE a.grantee = 'service_role'::regrole),
      count(*) FILTER (WHERE a.grantee = 'authenticated'::regrole)
      INTO v_anon, v_public, v_service, v_authed
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN LATERAL aclexplode(c.relacl) a ON true
     WHERE n.nspname = 'public'
       AND c.relname = v_t;

    IF v_anon <> 0 THEN
      RAISE EXCEPTION 'assert failed: public.% still grants % privilege(s) to anon', v_t, v_anon;
    END IF;

    IF v_public <> 0 THEN
      RAISE EXCEPTION 'assert failed: public.% still grants % privilege(s) to PUBLIC', v_t, v_public;
    END IF;

    -- Over-revoke guard. REVOKE ... FROM PUBLIC must not have taken anything the
    -- application depends on. If either of these is now zero, the change did more
    -- than it was meant to and must not be recorded as applied.
    IF v_service = 0 THEN
      RAISE EXCEPTION 'assert failed: public.% no longer grants anything to service_role, so this migration over-revoked', v_t;
    END IF;

    IF v_authed = 0 THEN
      RAISE EXCEPTION 'assert failed: public.% no longer grants anything to authenticated, so this migration over-revoked', v_t;
    END IF;

    v_checked := v_checked + 1;
  END LOOP;

  -- A check that verified nothing must not read as green.
  IF v_checked <> array_length(v_tables, 1) THEN
    RAISE EXCEPTION 'assert failed: checked % table(s) of %, so this result is not evidence of anything',
      v_checked, array_length(v_tables, 1);
  END IF;

  RAISE NOTICE 'vault grant post state ok: % of % table(s) carry no anon and no PUBLIC privilege, and service_role and authenticated are intact on each',
    v_checked, array_length(v_tables, 1);
END
$assert$;
