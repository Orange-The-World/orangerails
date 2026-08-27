-- Restrict public.record_stealth_scan_range to service_role.
--
-- This function is a server-side helper. Its only caller is the
-- or-stealth-envelope-update edge function, at index.ts:174, which invokes it
-- through the service_role client. No browser code path calls it: the widget
-- sends heights to that edge function and the edge function performs the RPC.
-- The grants the function currently carries are wider than that single caller
-- needs, so this narrows them to match the intent.
--
-- Why the migration that created it did not already do this. 20260821000000
-- ends with REVOKE ALL ... FROM PUBLIC followed by GRANT EXECUTE ... TO
-- service_role, which reads as service-role-only. It is not. Per-role EXECUTE
-- grants issued when a function is created are explicit grants, and a revoke
-- against PUBLIC does not remove them. Naming the roles is the only form that
-- does.
--
-- DL-1715: WHY THIS FILE NO LONGER NAMES A BARE SIGNATURE.
-- As first written this file opened with an unguarded
--
--   REVOKE EXECUTE ON FUNCTION public.record_stealth_scan_range(uuid, int, int)
--     FROM PUBLIC, anon, authenticated;
--
-- The 3-arg overload was later dropped by 20260824000000, which created a
-- 4-arg replacement (uuid, int, int, text). On any database where that drop has
-- already run, the statement above resolves to nothing and Postgres raises
-- 42883, aborting this file and the migration queue behind it. Both overloads
-- are now resolved through to_regprocedure, so an absent signature is skipped
-- with a notice rather than being fatal, and whichever one is present is
-- locked down.
--
-- The migration still FAILS if neither overload exists. A run that revoked
-- nothing must not report success: "I could not check" is not a pass, and that
-- silent-success shape is the reason this file exists at all.
--
-- Idempotent: REVOKE against an absent grant is a no-op, safe to re-run.
-- Reversible: GRANT EXECUTE ON FUNCTION ... TO anon, authenticated, though
-- doing so would restore grants no caller uses.

DO $revoke$
DECLARE
  v_sig  text;
  v_sigs text[] := ARRAY[
    'public.record_stealth_scan_range(uuid,int,int)',
    'public.record_stealth_scan_range(uuid,int,int,text)'
  ];
  v_hit  int := 0;
  v_skip int := 0;
BEGIN
  -- A database without the Supabase API roles has nothing to revoke from, and
  -- naming a role that does not exist is itself an error. Say so and stop.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE NOTICE 'role anon does not exist on this database, nothing to revoke';
    RETURN;
  END IF;

  FOREACH v_sig IN ARRAY v_sigs LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      v_skip := v_skip + 1;
      RAISE NOTICE 'skipped, signature absent on this database: %', v_sig;
      CONTINUE;
    END IF;
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_sig);
    v_hit := v_hit + 1;
  END LOOP;

  IF v_hit = 0 THEN
    RAISE EXCEPTION
      'FAIL: no record_stealth_scan_range overload exists here, so this migration revoked nothing (% signature(s) skipped)',
      v_skip;
  END IF;

  RAISE NOTICE 'revoked on % overload(s), skipped % absent signature(s)', v_hit, v_skip;
END
$revoke$;

-- Post-conditions. Fail the migration rather than report a success that left
-- the grants in place, which is how the first attempt slipped through. Only
-- signatures that actually exist here are asserted on, for the same reason the
-- revoke above is guarded.
DO $verify$
DECLARE
  v_sig  text;
  v_oid  oid;
  v_sigs text[] := ARRAY[
    'public.record_stealth_scan_range(uuid,int,int)',
    'public.record_stealth_scan_range(uuid,int,int,text)'
  ];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RETURN;
  END IF;

  FOREACH v_sig IN ARRAY v_sigs LOOP
    v_oid := to_regprocedure(v_sig);
    CONTINUE WHEN v_oid IS NULL;

    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL: anon still holds EXECUTE on %', v_sig;
    END IF;

    IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL: authenticated still holds EXECUTE on %', v_sig;
    END IF;

    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL: service_role lost EXECUTE on %', v_sig;
    END IF;
  END LOOP;
END
$verify$;
