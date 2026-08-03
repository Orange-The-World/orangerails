-- 20260723190000_revoke_anon_execute_public_functions.sql
--
-- WHY
-- Supabase default privileges grant EXECUTE on every newly created function in
-- the public schema to anon, authenticated and service_role. Our standard is
-- that a function carries a grant only for the roles that actually call it.
-- A number of functions in public still carry the default named anon grant that
-- was never removed when the function was created, so the grant list does not
-- match the caller list. This migration brings them back in line.
--
-- WHAT THIS DOES
-- Removes EXECUTE from anon, split into two groups because the grant arrived by
-- two different routes:
--   Group A (10 functions): a PUBLIC entry AND a named anon entry. Both go.
--   Group B (17 functions): a named anon entry only. Only anon goes.
-- No blanket revoke is issued across the whole set, and every function is named
-- by its full identity signature with argument types so a same named overload
-- cannot be missed.
--
-- WHAT THIS DOES NOT DO
--   * It does not touch authenticated, service_role or postgres. Every verified
--     caller keeps its grant:
--       - the API tokens screen calls create_or_access_token as authenticated
--       - the shared rate limit helper calls increment_platform_rate_limit on
--         the service client, and fails open on error in any case
--       - the widget session cleanup runs from a scheduled job as postgres
--       - the trigger functions are invoked by the trigger machinery, which does
--         not consult EXECUTE at fire time
--   * It does not change the default privileges for future functions. A function
--     created after this migration is still granted to anon at creation. Closing
--     that is a separate, forward only change and is out of scope here.
--
-- KNOWN BEHAVIOUR CHANGE
-- public.is_staff() is referenced inside row level security policies. A policy
-- expression is evaluated as the calling role, so a caller holding the anon role
-- that reads one of those tables now gets a permission denied on the function
-- instead of an empty result. The rows returned are the same either way, zero,
-- but the shape of the response changes from empty to error. Flagged here so it
-- is not read as a regression.
--
-- REVERSIBILITY
-- Fully reversible. Nothing is dropped, no data is touched, no table is locked.
-- The undo is the matching GRANT and is written out at the bottom of this file.
--
-- IDEMPOTENCY
-- REVOKE is a no op when the privilege is already absent, and every function is
-- guarded by to_regprocedure so a signature that does not exist on a given
-- environment is skipped with a notice instead of failing the run. Safe to
-- re-run any number of times.

DO $migration$
DECLARE
  v_sig  text;
  v_hit  int := 0;
  v_skip int := 0;

  -- Group A: PUBLIC entry plus named anon entry. Revoke both grantees.
  v_group_a text[] := ARRAY[
    'public.canonical_audit_bytes(bigint,uuid,uuid,text,text,text,text,text,text,inet,text,text,timestamp with time zone)',
    'public.channel_state_guard_update_id()',
    'public.channel_state_stamp_closed_at()',
    'public.cleanup_expired_widget_sessions()',
    'public.increment_platform_rate_limit(text,text,timestamp with time zone)',
    'public.is_staff()',
    'public.orbi_set_updated_at()',
    'public.set_updated_at()',
    'public.stealth_connections_touch_updated_at()',
    'public.touch_updated_at()'
  ];

  -- Group B: named anon entry only. Revoke anon, leave PUBLIC alone.
  v_group_b text[] := ARRAY[
    'public.cleanup_expired_agent_invitation_tokens()',
    'public.complete_agent_invitation(uuid,uuid,text,text)',
    'public.create_or_access_token(text)',
    'public.get_agent_pubkey_for_refresh(uuid)',
    'public.get_coadmin_emails(uuid[])',
    'public.get_or_create_direct_subaccount()',
    'public.list_or_access_tokens()',
    'public.log_agent_token_refresh(uuid,uuid,inet,text)',
    'public.lookup_user_for_coadmin(text)',
    'public.mint_agent_invitation(text,agent_kind,agent_role,text,inet,text)',
    'public.peek_agent_invitation(text)',
    'public.revoke_agent_invitation_token(uuid)',
    'public.revoke_agent_member(uuid,text)',
    'public.revoke_or_access_token(text)',
    'public.rotate_data_key(uuid,uuid,jsonb,text)',
    'public.rotate_or_access_token(uuid)',
    'public.touch_agent_activity(uuid)'
  ];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'role anon does not exist on this database, nothing to revoke';
    RETURN;
  END IF;

  -- Group A
  FOREACH v_sig IN ARRAY v_group_a LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      v_skip := v_skip + 1;
      RAISE NOTICE 'group A skipped, signature absent here: %', v_sig;
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', v_sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', v_sig);
    v_hit := v_hit + 1;
  END LOOP;

  -- Group B
  FOREACH v_sig IN ARRAY v_group_b LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      v_skip := v_skip + 1;
      RAISE NOTICE 'group B skipped, signature absent here: %', v_sig;
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', v_sig);
    v_hit := v_hit + 1;
  END LOOP;

  RAISE NOTICE 'revoked on % function(s), skipped % absent signature(s)', v_hit, v_skip;
END
$migration$;

-- Post condition. Fails the transaction if any listed signature that exists on
-- this database is still executable by anon.
DO $verify$
DECLARE
  v_sig  text;
  v_left text[] := ARRAY[]::text[];
  v_all  text[] := ARRAY[
    'public.canonical_audit_bytes(bigint,uuid,uuid,text,text,text,text,text,text,inet,text,text,timestamp with time zone)',
    'public.channel_state_guard_update_id()',
    'public.channel_state_stamp_closed_at()',
    'public.cleanup_expired_widget_sessions()',
    'public.increment_platform_rate_limit(text,text,timestamp with time zone)',
    'public.is_staff()',
    'public.orbi_set_updated_at()',
    'public.set_updated_at()',
    'public.stealth_connections_touch_updated_at()',
    'public.touch_updated_at()',
    'public.cleanup_expired_agent_invitation_tokens()',
    'public.complete_agent_invitation(uuid,uuid,text,text)',
    'public.create_or_access_token(text)',
    'public.get_agent_pubkey_for_refresh(uuid)',
    'public.get_coadmin_emails(uuid[])',
    'public.get_or_create_direct_subaccount()',
    'public.list_or_access_tokens()',
    'public.log_agent_token_refresh(uuid,uuid,inet,text)',
    'public.lookup_user_for_coadmin(text)',
    'public.mint_agent_invitation(text,agent_kind,agent_role,text,inet,text)',
    'public.peek_agent_invitation(text)',
    'public.revoke_agent_invitation_token(uuid)',
    'public.revoke_agent_member(uuid,text)',
    'public.revoke_or_access_token(text)',
    'public.rotate_data_key(uuid,uuid,jsonb,text)',
    'public.rotate_or_access_token(uuid)',
    'public.touch_agent_activity(uuid)'
  ];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RETURN;
  END IF;

  FOREACH v_sig IN ARRAY v_all LOOP
    IF to_regprocedure(v_sig) IS NOT NULL
       AND has_function_privilege('anon', to_regprocedure(v_sig), 'EXECUTE') THEN
      v_left := v_left || v_sig;
    END IF;
  END LOOP;

  IF array_length(v_left, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'anon still holds EXECUTE on: %', array_to_string(v_left, ', ');
  END IF;

  -- Callers that must keep working.
  IF to_regprocedure('public.create_or_access_token(text)') IS NOT NULL
     AND NOT has_function_privilege('authenticated', to_regprocedure('public.create_or_access_token(text)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated lost EXECUTE on create_or_access_token(text)';
  END IF;

  IF to_regprocedure('public.is_staff()') IS NOT NULL
     AND NOT has_function_privilege('authenticated', to_regprocedure('public.is_staff()'), 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated lost EXECUTE on is_staff()';
  END IF;

  IF to_regprocedure('public.increment_platform_rate_limit(text,text,timestamp with time zone)') IS NOT NULL
     AND NOT has_function_privilege('service_role', to_regprocedure('public.increment_platform_rate_limit(text,text,timestamp with time zone)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost EXECUTE on increment_platform_rate_limit';
  END IF;

  RAISE NOTICE 'post condition passed: anon holds no EXECUTE on the listed set';
END
$verify$;

-- ---------------------------------------------------------------------------
-- ROLLBACK (run by hand only, this restores a grant we deliberately removed)
--
-- DO $rollback$
-- DECLARE
--   v_sig text;
--   v_a text[] := ARRAY[ ... group A signatures above ... ];
--   v_b text[] := ARRAY[ ... group B signatures above ... ];
-- BEGIN
--   FOREACH v_sig IN ARRAY v_a LOOP
--     IF to_regprocedure(v_sig) IS NOT NULL THEN
--       EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', v_sig);
--       EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon', v_sig);
--     END IF;
--   END LOOP;
--   FOREACH v_sig IN ARRAY v_b LOOP
--     IF to_regprocedure(v_sig) IS NOT NULL THEN
--       EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon', v_sig);
--     END IF;
--   END LOOP;
-- END
-- $rollback$;
-- ---------------------------------------------------------------------------
