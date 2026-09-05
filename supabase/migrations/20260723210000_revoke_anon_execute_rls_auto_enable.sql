-- Revoke anon and PUBLIC EXECUTE on public.rls_auto_enable().
--
-- Requirement: no function in the public schema is executable by the anon
-- role. This is the last remaining exception.
--
-- The grant reaches anon by two paths, an empty-grantee (PUBLIC) entry and a
-- direct anon entry, so both names must be revoked. A single-name revoke
-- leaves the other path in force.
--
-- No behaviour change: an event trigger function is fired by the system, which
-- does not check EXECUTE privilege on the role performing the DDL.
--
-- Re-runnable: guarded with to_regprocedure, so it is a no-op where the
-- function is absent and safe to apply twice.
--
-- Undo: GRANT EXECUTE ON FUNCTION public.rls_auto_enable() TO anon, PUBLIC;

DO $$
DECLARE
  f regprocedure := to_regprocedure('public.rls_auto_enable()');
BEGIN
  IF f IS NULL THEN
    RAISE NOTICE 'public.rls_auto_enable() not present, nothing to revoke';
    RETURN;
  END IF;

  EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
  EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', f);
END
$$;

-- Post-condition: abort the transaction if the grant survived.
DO $$
DECLARE
  f regprocedure := to_regprocedure('public.rls_auto_enable()');
BEGIN
  IF f IS NOT NULL AND has_function_privilege('anon', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'post-condition failed: anon still holds EXECUTE on %', f;
  END IF;
END
$$;
