-- Allow co-admins to read the owner's user_vault_meta row.
-- Required so the admin can fetch workspace_key_id + kem_secret_wrapped
-- during the workspace-switch consume flow.
CREATE POLICY "co-admins can read owner vault meta"
  ON public.user_vault_meta
  FOR SELECT
  TO authenticated
  USING (
    user_id IN (
      SELECT owner_user_id
      FROM public.workspace_admins
      WHERE admin_user_id = auth.uid()
    )
  );
