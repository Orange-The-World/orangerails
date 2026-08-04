-- DL-0610: harden enforce_kem_public_key_write_once with explicit search_path
-- Verified on dev (fzwmnzmtqidumdqjdddz): proconfig was NULL, no search_path set.
-- New migration rather than editing the already-applied original.

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
