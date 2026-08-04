-- Pin search_path on enforce_kem_public_key_write_once.
-- The original migration applied without SET search_path, leaving proconfig NULL.
-- This replacement adds the pin without touching the already-applied migration file.
CREATE OR REPLACE FUNCTION public.enforce_kem_public_key_write_once()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
AS $function$
BEGIN
  IF OLD.kem_public_key IS NOT NULL
     AND NEW.kem_public_key IS DISTINCT FROM OLD.kem_public_key THEN
    RAISE EXCEPTION
      'kem_public_key is write-once: it cannot be changed or cleared once set'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
