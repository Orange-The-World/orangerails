-- RPC to look up emails for users connected via co-admin relationships.
-- Only returns emails for users the caller has an established trust relationship
-- with (either as owner or as admin) — prevents arbitrary email harvesting.
CREATE OR REPLACE FUNCTION public.get_coadmin_emails(user_ids UUID[])
RETURNS TABLE(user_id UUID, email TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  RETURN QUERY
  SELECT au.id, au.email::TEXT
  FROM auth.users au
  WHERE au.id = ANY(user_ids)
    AND (
      EXISTS (
        SELECT 1 FROM public.workspace_admins wa
        WHERE wa.owner_user_id = auth.uid() AND wa.admin_user_id = au.id
      )
      OR
      EXISTS (
        SELECT 1 FROM public.workspace_admins wa
        WHERE wa.admin_user_id = auth.uid() AND wa.owner_user_id = au.id
      )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_coadmin_emails(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_coadmin_emails(UUID[]) TO authenticated;
