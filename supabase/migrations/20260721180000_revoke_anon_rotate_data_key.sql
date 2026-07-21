-- Remove the anon EXECUTE grant on rotate_data_key.
--
-- rotate_data_key is SECURITY DEFINER: it runs with owner rights and does its
-- own authorization inside the body. It carries an EXECUTE grant for anon, the
-- role every unauthenticated request runs as. The body opens by requiring an
-- auth context and raising on a null caller, so an unauthenticated request
-- already fails before it can write anything. The grant is still wrong: a
-- definer function on the key management surface should not be reachable by the
-- unauthenticated role at all, and today the body check is the only thing
-- standing between the public key and owner rights.
--
-- authenticated already holds no EXECUTE grant on this function on either
-- project, so it is named in the REVOKE only to make the intended end state
-- explicit. Nothing is granted here.
--
-- postgres and service_role grants are untouched, so no documented caller
-- loses access.
--
-- Idempotent: a REVOKE of a privilege that is already absent is a no-op, and
-- the to_regprocedure guard skips a project that does not carry the function
-- rather than failing the whole run.
--
-- Reversible, run as postgres:
--   GRANT EXECUTE ON FUNCTION public.rotate_data_key(uuid,uuid,jsonb,text) TO anon;

BEGIN;

DO $$
DECLARE
  v_sig text := 'public.rotate_data_key(uuid,uuid,jsonb,text)';
BEGIN
  IF to_regprocedure(v_sig) IS NULL THEN
    RAISE NOTICE 'skipped, function not present on this project: %', v_sig;
  ELSE
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated, PUBLIC',
      v_sig
    );
  END IF;
END
$$;

COMMIT;
