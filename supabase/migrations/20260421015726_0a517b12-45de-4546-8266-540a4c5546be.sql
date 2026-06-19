CREATE OR REPLACE FUNCTION public.lookup_user_for_coadmin(target_email TEXT)
RETURNS TABLE(user_id UUID, kem_public_key TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  RETURN QUERY
  SELECT au.id, uvm.kem_public_key
  FROM auth.users au
  JOIN public.user_vault_meta uvm ON uvm.user_id = au.id
  WHERE lower(au.email) = lower(target_email)
    AND au.id <> auth.uid()
    AND uvm.kem_public_key IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.lookup_user_for_coadmin(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_user_for_coadmin(TEXT) TO authenticated;