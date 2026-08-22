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
-- Idempotent: REVOKE against an absent grant is a no-op, safe to re-run.
-- Reversible: GRANT EXECUTE ON FUNCTION ... TO anon, authenticated, though
-- doing so would restore grants no caller uses.

REVOKE EXECUTE ON FUNCTION public.record_stealth_scan_range(uuid, int, int)
  FROM PUBLIC, anon, authenticated;

-- Post-conditions. Fail the migration rather than report a success that left
-- the grants in place, which is how the first attempt slipped through.
DO $$
BEGIN
  IF has_function_privilege('anon',
       'public.record_stealth_scan_range(uuid,int,int)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: anon still holds EXECUTE on record_stealth_scan_range';
  END IF;

  IF has_function_privilege('authenticated',
       'public.record_stealth_scan_range(uuid,int,int)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: authenticated still holds EXECUTE on record_stealth_scan_range';
  END IF;

  IF NOT has_function_privilege('service_role',
       'public.record_stealth_scan_range(uuid,int,int)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: service_role lost EXECUTE on record_stealth_scan_range';
  END IF;
END $$;
