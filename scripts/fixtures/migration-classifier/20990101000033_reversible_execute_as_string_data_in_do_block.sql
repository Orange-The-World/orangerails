-- OR-T1696/step-9. EXECUTE appears as STRING DATA, not a PL/pgSQL command.
--
-- Both failing patterns from the real migration files:
--   x.privilege_type = 'EXECUTE'
--   has_function_privilege('anon', p.oid::regprocedure, 'EXECUTE')
--
-- scrubDoBody keeps string literals verbatim (the literal IS the dynamic SQL),
-- so 'EXECUTE' stays in the scanned text. Before the fix, \bEXECUTE\b matched
-- at the quote/letter word boundary and executeIsUnreadable returned true,
-- classifying these migrations IRREVERSIBLE.
--
-- Correct verdict: REVERSIBLE. The DO block only issues REVOKE statements
-- (a privilege name, exempted by PRIVILEGE_LIST_PREFIX) and no operation here
-- has no restore path.
DO $$
DECLARE
  r record;
BEGIN
  -- Revoke public EXECUTE on functions that information_schema reports as
  -- having the privilege. privilege_type = 'EXECUTE' is STRING DATA, not a
  -- PL/pgSQL EXECUTE command.
  FOR r IN
    SELECT DISTINCT rp.routine_name, rp.specific_schema
    FROM information_schema.routine_privileges rp
    WHERE rp.privilege_type = 'EXECUTE'
      AND rp.grantee = 'PUBLIC'
      AND rp.specific_schema NOT IN ('pg_catalog', 'information_schema')
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %I.%I FROM PUBLIC',
      r.specific_schema,
      r.routine_name
    );
  END LOOP;

  -- has_function_privilege(..., 'EXECUTE') is also string data.
  FOR r IN
    SELECT p.oid, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND has_function_privilege('anon', p.oid::regprocedure, 'EXECUTE')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %I FROM anon', r.proname);
  END LOOP;
END
$$;
